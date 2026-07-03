import { TeamMemoryHttpClient } from "../http/client.ts";

export interface ClaudeCodeHookPayload {
  hook_event_name?: string;
  prompt?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface ClaudeCodeHookResponse {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext?: string;
  };
}

export interface ClaudeCodeLifecycleClient {
  recallHostMemory(host: string, input: Record<string, unknown>): Promise<unknown>;
  captureHostMemory(host: string, input: Record<string, unknown>): Promise<unknown>;
}

export class ClaudeCodeTeamMemoryHooks {
  private readonly client: ClaudeCodeLifecycleClient;

  constructor(client: ClaudeCodeLifecycleClient) {
    this.client = client;
  }

  static fromHttp(options: {
    baseUrl: string;
    token: string;
    fetch?: typeof fetch;
  }): ClaudeCodeTeamMemoryHooks {
    return new ClaudeCodeTeamMemoryHooks(new TeamMemoryHttpClient(options));
  }

  async userPromptSubmit(
    payload: ClaudeCodeHookPayload,
  ): Promise<ClaudeCodeHookResponse> {
    const userPrompt = requiredPrompt(payload);
    const context = await this.client.recallHostMemory("claude_code", {
      sessionId: sessionId(payload),
      userPrompt,
      ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
      ...(typeof payload.transcript_path === "string"
        ? { transcriptPath: payload.transcript_path }
        : {}),
    }) as { text?: string };
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        ...(typeof context.text === "string" && context.text.length > 0
          ? { additionalContext: context.text }
          : {}),
      },
    };
  }

  async stop(
    payload: ClaudeCodeHookPayload,
    outcome: "success" | "failure" | "unknown" = "success",
  ): Promise<ClaudeCodeHookResponse> {
    await this.client.captureHostMemory("claude_code", {
      sessionId: sessionId(payload),
      outcome,
      ...(typeof payload.prompt === "string" ? { userPrompt: payload.prompt } : {}),
      ...(typeof payload.transcript_path === "string"
        ? { transcriptPath: payload.transcript_path }
        : {}),
    });
    return {
      hookSpecificOutput: {
        hookEventName: payload.hook_event_name ?? "Stop",
      },
    };
  }

  stopFailure(payload: ClaudeCodeHookPayload): Promise<ClaudeCodeHookResponse> {
    return this.stop(payload, "failure");
  }
}

function requiredPrompt(payload: ClaudeCodeHookPayload): string {
  if (typeof payload.prompt !== "string" || payload.prompt.length === 0) {
    throw new Error("Claude Code hook payload.prompt is required");
  }
  return payload.prompt;
}

function sessionId(payload: ClaudeCodeHookPayload): string {
  return typeof payload.session_id === "string" && payload.session_id.length > 0
    ? payload.session_id
    : "claude-code";
}

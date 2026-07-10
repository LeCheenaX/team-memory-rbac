import { createClient, type Client } from "@libsql/client";

/** Creates the libSQL client used by production adapters. */
export function createLibsqlClient(options: {
  url: string;
  authToken?: string;
}): Client {
  if (options.url.length === 0) {
    throw new Error("libsql.url must be configured");
  }
  return createClient(options);
}

export type LibsqlClient = Client;

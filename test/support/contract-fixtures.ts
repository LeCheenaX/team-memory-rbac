import type {
  MemoryEntity,
  MemoryEntityBranch,
  MemoryObjectIdentity,
  Resource,
  ResourceChunk,
} from "../../src/contracts/memory.ts";
import type {
  AgentIdentity,
  Role,
  TaskScope,
  User,
  UserRootRoleAssignment,
} from "../../src/contracts/rbac.ts";

const timestamp = "2026-06-25T00:00:00.000Z";

const user: User = {
  id: "user-alice",
  displayName: "Alice",
  status: "active",
  createdAt: timestamp,
  updatedAt: timestamp,
};

const agent: AgentIdentity = {
  id: "agent-research",
  ownerUserId: user.id,
  agentType: "sub_agent",
  displayName: "Research Agent",
  status: "active",
  createdAt: timestamp,
  updatedAt: timestamp,
};

const rootEntity: MemoryEntity = {
  id: "root-project-a",
  rootEntityId: null,
  status: "active",
  currentBranchId: "branch-root-main",
  createdAt: timestamp,
  updatedAt: timestamp,
};

const researcherRole: Role = {
  id: "role-researcher",
  name: "researcher",
  kind: "built_in",
  permissions: [
    {
      action: "read",
      resourceKind: "memory_entity",
    },
    {
      action: "search",
      resourceKind: "memory_entity",
    },
  ],
  status: "active",
};

const assignment: UserRootRoleAssignment = {
  id: "assignment-alice-project-a-researcher",
  userId: user.id,
  rootEntityId: rootEntity.id,
  roleId: researcherRole.id,
  assignedBy: "user-admin",
  assignedAt: timestamp,
  status: "active",
};

const taskScope: TaskScope = {
  rootEntityId: rootEntity.id,
  allowedTags: ["architecture"],
  relationExpansionPolicy: {
    allowedRelationTypes: ["has", "depends_on", "refers_to"],
    maxDepth: 2,
    allowRequiredDependencies: true,
  },
};

const memoryEntity: MemoryEntity = {
  id: "entity-architecture",
  rootEntityId: rootEntity.id,
  status: "active",
  currentBranchId: "branch-architecture-main",
  createdAt: timestamp,
  updatedAt: timestamp,
};

const memoryEntityBranch: MemoryEntityBranch = {
  id: "branch-architecture-main",
  entityId: memoryEntity.id,
  rootEntityId: rootEntity.id,
  branchRef: "main",
  commitId: "commit-initial",
  title: "Architecture",
  description: "Project architecture decisions",
  tags: ["architecture"],
  importance: 0.8,
  confidence: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const resource: Resource = {
  id: "resource-readme",
  rootEntityId: rootEntity.id,
  sourceType: "document",
  title: "README",
  contentHash: "sha256:readme",
  createdAt: timestamp,
  updatedAt: timestamp,
};

const resourceChunk: ResourceChunk = {
  id: "chunk-readme-0",
  rootEntityId: rootEntity.id,
  resourceId: resource.id,
  chunkIndex: 0,
  text: "Project architecture decisions",
  createdAt: timestamp,
  updatedAt: timestamp,
};

const memoryObjects: MemoryObjectIdentity[] = [
  {
    kind: "memory_entity",
    id: rootEntity.id,
    rootEntityId: rootEntity.rootEntityId,
  },
  {
    kind: "memory_entity",
    id: memoryEntity.id,
    rootEntityId: memoryEntity.rootEntityId,
  },
  {
    kind: "memory_entity_branch",
    id: memoryEntityBranch.id,
    rootEntityId: memoryEntityBranch.rootEntityId,
  },
  {
    kind: "resource",
    id: resource.id,
    rootEntityId: resource.rootEntityId,
  },
  {
    kind: "resource_chunk",
    id: resourceChunk.id,
    rootEntityId: resourceChunk.rootEntityId,
  },
];

export const contractFixtures = {
  user,
  agent,
  rootEntity,
  researcherRole,
  assignment,
  taskScope,
  memoryEntity,
  memoryEntityBranch,
  resource,
  resourceChunk,
  memoryObjects,
};

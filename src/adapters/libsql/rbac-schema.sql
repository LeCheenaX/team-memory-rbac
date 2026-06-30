create table if not exists rbac_users (
  user_id text primary key,
  payload_json text not null
);

create table if not exists rbac_agents (
  agent_id text primary key,
  owner_user_id text not null,
  payload_json text not null
);

create table if not exists rbac_roles (
  role_id text primary key,
  payload_json text not null
);

create table if not exists rbac_assignments (
  assignment_id text primary key,
  user_id text not null,
  root_entity_id text not null,
  payload_json text not null
);

create index if not exists rbac_assignments_subject_root
  on rbac_assignments(user_id, root_entity_id);

create table if not exists rbac_delegations (
  delegation_id text primary key,
  agent_id text not null,
  owner_user_id text not null,
  root_entity_id text not null,
  payload_json text not null
);

create index if not exists rbac_delegations_agent_root
  on rbac_delegations(agent_id, root_entity_id);

create table if not exists rbac_sessions (
  session_id text primary key,
  token_hash text not null unique,
  user_id text not null,
  agent_id text,
  root_entity_id text not null,
  task_scope_json text not null,
  delegation_id text,
  parent_agent_id text,
  expires_at text not null,
  revoked_at text,
  created_at text not null
);

create table if not exists rbac_audit_log (
  audit_id text primary key,
  root_entity_id text not null,
  actor_user_id text not null,
  action text not null,
  payload_json text not null,
  created_at text not null
);

create index if not exists rbac_audit_log_root_created
  on rbac_audit_log(root_entity_id, created_at);

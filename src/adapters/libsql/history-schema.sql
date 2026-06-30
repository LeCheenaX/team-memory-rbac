-- Cloud History is independent from Memory's Qdrant payloads and relation table.
-- The journal and the normalized tables are committed atomically by the adapter.
create table if not exists history_request_journal (
  sequence integer primary key autoincrement,
  request_kind text not null,
  request_json text not null
);

create table if not exists history_idempotency (
  root_entity_id text not null,
  branch_ref text not null,
  client_mutation_id text not null,
  request_kind text not null,
  request_json text not null,
  result_json text not null,
  primary key (root_entity_id, branch_ref, client_mutation_id, request_kind)
);

create table if not exists history_commits (
  sequence integer primary key,
  commit_id text not null unique,
  root_entity_id text not null,
  target_branch_ref text not null,
  stored_branch_ref text not null,
  client_mutation_id text not null,
  status text not null,
  conflict_keys_json text not null,
  payload_json text not null
);

create unique index if not exists history_commits_idempotency
  on history_commits(root_entity_id, target_branch_ref, client_mutation_id);

create table if not exists history_operations (
  operation_id text primary key,
  commit_id text not null references history_commits(commit_id),
  root_entity_id text not null,
  branch_ref text not null,
  operation_kind text not null,
  input_json text not null,
  provenance_json text,
  created_at text not null
);

create table if not exists history_branch_heads (
  root_entity_id text not null,
  branch_ref text not null,
  head_commit_id text,
  status text not null,
  updated_at text not null,
  primary key (root_entity_id, branch_ref)
);

create table if not exists history_conflicts (
  conflict_id text primary key,
  root_entity_id text not null,
  target_branch_ref text not null,
  conflict_branch_ref text not null,
  incoming_commit_id text not null,
  status text not null,
  resolution_commit_id text,
  payload_json text not null
);

create table if not exists history_resolutions (
  resolution_commit_id text not null,
  conflict_id text not null references history_conflicts(conflict_id),
  incoming_commit_id text not null,
  resolution_kind text not null,
  primary key (resolution_commit_id, conflict_id)
);

create table if not exists history_sync_watermarks (
  replica_id text primary key,
  root_entity_id text not null,
  branch_ref text not null,
  commit_watermark integer not null,
  permission_watermark text,
  updated_at text not null
);

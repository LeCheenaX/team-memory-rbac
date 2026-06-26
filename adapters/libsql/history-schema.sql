-- History is independent from Memory's Qdrant payloads and relation table.
create table if not exists history_commits (
  commit_id text primary key,
  root_entity_id text not null,
  branch_ref text not null,
  parent_commit_id text,
  actor_kind text not null,
  actor_id text not null,
  message text,
  created_at text not null
);

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

create table if not exists history_conflict_keys (
  commit_id text not null references history_commits(commit_id),
  conflict_key text not null,
  primary key (commit_id, conflict_key)
);

create table if not exists history_conflicts (
  conflict_id text primary key,
  root_entity_id text not null,
  target_branch_ref text not null,
  conflict_branch_ref text not null,
  incoming_commit_id text not null,
  status text not null,
  resolution_commit_id text,
  created_at text not null
);

create table if not exists history_resolutions (
  resolution_commit_id text primary key references history_commits(commit_id),
  conflict_id text not null references history_conflicts(conflict_id),
  incoming_commit_id text not null,
  resolution_kind text not null
);

create table if not exists history_sync_watermarks (
  replica_id text primary key,
  root_entity_id text not null,
  branch_ref text not null,
  commit_watermark integer not null,
  permission_watermark text,
  updated_at text not null
);

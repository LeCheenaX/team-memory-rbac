CREATE TABLE IF NOT EXISTS team_memory_authority_state (
  authority_key text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_memory_commits (
  authority_key text NOT NULL,
  sequence bigint NOT NULL,
  commit_id text NOT NULL,
  root_entity_id text NOT NULL,
  target_branch_ref text NOT NULL,
  stored_branch_ref text NOT NULL,
  client_mutation_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted', 'conflicted')),
  conflict_keys jsonb NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (authority_key, commit_id),
  UNIQUE (authority_key, sequence)
);

CREATE TABLE IF NOT EXISTS team_memory_operations (
  authority_key text NOT NULL,
  operation_id text NOT NULL,
  commit_id text NOT NULL,
  root_entity_id text NOT NULL,
  branch_ref text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (authority_key, operation_id)
);

CREATE TABLE IF NOT EXISTS team_memory_conflicts (
  authority_key text NOT NULL,
  conflict_id text NOT NULL,
  root_entity_id text NOT NULL,
  target_branch_ref text NOT NULL,
  conflict_branch_ref text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (authority_key, conflict_id)
);

CREATE TABLE IF NOT EXISTS team_memory_active_projections (
  authority_key text NOT NULL,
  root_entity_id text NOT NULL,
  branch_ref text NOT NULL,
  commit_watermark bigint NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (authority_key, root_entity_id, branch_ref)
);

CREATE TABLE IF NOT EXISTS team_memory_outbox (
  authority_key text NOT NULL,
  event_id text NOT NULL,
  sequence bigint NOT NULL,
  root_entity_id text NOT NULL,
  branch_ref text NOT NULL,
  kind text NOT NULL,
  commit_id text NOT NULL,
  published_at timestamptz,
  PRIMARY KEY (authority_key, event_id)
);

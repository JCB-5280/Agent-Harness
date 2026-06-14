-- ============================================================
-- Agent Harness — DuckDB schema
-- Single file database: data/harness.duckdb
-- This is the ONLY coordination mechanism between agents.
-- Agents never talk to each other directly; they read and
-- write rows here, and the orchestrator routes work.
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS task_id_seq;
CREATE SEQUENCE IF NOT EXISTS run_id_seq;
CREATE SEQUENCE IF NOT EXISTS event_id_seq;

-- ------------------------------------------------------------
-- tasks: the work queue. Every unit of work for every role.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
    id          BIGINT PRIMARY KEY DEFAULT nextval('task_id_seq'),
    role        VARCHAR NOT NULL,              -- 'pm' | 'dev' | 'reviewer' | 'qa' | 'comms'
    title       VARCHAR NOT NULL,
    payload     JSON,                          -- role-specific instructions, branch names, PR urls, repro steps
    status      VARCHAR NOT NULL DEFAULT 'queued',
                                               -- queued | in_progress | done | failed | blocked | cancelled
    priority    INTEGER NOT NULL DEFAULT 50,   -- lower = sooner
    created_by  VARCHAR NOT NULL,              -- 'human' or a role name
    blocked_on  BIGINT,                        -- task id this task waits for (nullable)
    project     VARCHAR,                       -- repo / project slug
    attempts    INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    created_at  TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at  TIMESTAMP NOT NULL DEFAULT current_timestamp
);

-- ------------------------------------------------------------
-- runs: one row per agent session the orchestrator spawns.
-- This is your audit log of everything the system did.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
    id          BIGINT PRIMARY KEY DEFAULT nextval('run_id_seq'),
    task_id     BIGINT NOT NULL,
    role        VARCHAR NOT NULL,
    started_at  TIMESTAMP NOT NULL DEFAULT current_timestamp,
    finished_at TIMESTAMP,
    exit_code   INTEGER,
    result      VARCHAR,                       -- 'success' | 'failure' | 'timeout' | 'crashed'
    summary     VARCHAR,                       -- agent's own one-paragraph summary of what it did
    cost_usd    DOUBLE,                        -- if reported by the CLI
    num_turns   INTEGER,
    log_path    VARCHAR                        -- path to full session transcript on disk
);

-- ------------------------------------------------------------
-- events: lightweight notes agents leave for humans / comms.
-- The comms agent drains this table to write digests.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id          BIGINT PRIMARY KEY DEFAULT nextval('event_id_seq'),
    role        VARCHAR NOT NULL,
    task_id     BIGINT,
    kind        VARCHAR NOT NULL,              -- 'info' | 'pr_opened' | 'pr_approved' | 'defect' | 'alert' | 'digest'
    message     VARCHAR NOT NULL,
    url         VARCHAR,
    created_at  TIMESTAMP NOT NULL DEFAULT current_timestamp,
    digested    BOOLEAN NOT NULL DEFAULT false -- set true once comms has reported it
);

-- ------------------------------------------------------------
-- heartbeats: orchestrator liveness, handy for monitoring.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS heartbeats (
    ts          TIMESTAMP NOT NULL DEFAULT current_timestamp,
    note        VARCHAR
);

-- ------------------------------------------------------------
-- settings: runtime-tunable knobs, surfaced and edited via UI.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
    key         VARCHAR PRIMARY KEY,
    value       VARCHAR NOT NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT current_timestamp
);
INSERT INTO settings VALUES ('paused', 'false', current_timestamp) ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- DAG support: tasks gain a dependency list and a DAG id.
-- (blocked_on is retained for backward-compatible single-dep tasks.)
-- ------------------------------------------------------------
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deps JSON;        -- array of task ids
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dag_id VARCHAR;   -- which run-DAG this task belongs to
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dag_key VARCHAR;  -- this task's local handle within its DAG

CREATE SEQUENCE IF NOT EXISTS dag_seq;
CREATE TABLE IF NOT EXISTS dags (
    id          VARCHAR PRIMARY KEY,           -- human-readable id (see naming convention)
    objective   VARCHAR NOT NULL,
    created_by  VARCHAR NOT NULL,
    project     VARCHAR,
    node_count  INTEGER NOT NULL,
    spec        JSON NOT NULL,                 -- the full graph: nodes, deps, mapping to task ids
    artifact    VARCHAR,                       -- path of the committed JSON artifact
    status      VARCHAR NOT NULL DEFAULT 'active',
    created_at  TIMESTAMP NOT NULL DEFAULT current_timestamp
);

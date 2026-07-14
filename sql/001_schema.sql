-- pgmem schema, generated for vector(1536).
-- Standalone use: psql "$DATABASE_URL" -f sql/001_schema.sql -f sql/002_functions.sql
-- (edit the vector dimension first if your embedder differs).
-- SDK use: PgMem.migrate() generates this DDL with your embedder's dimension.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS pgmem_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS pgmem_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace text NOT NULL DEFAULT 'default',
  content text NOT NULL,
  embedding vector(1536) NOT NULL,
  importance real NOT NULL DEFAULT 1.0 CHECK (importance > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz NOT NULL DEFAULT now(),
  access_count integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pgmem_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace text NOT NULL DEFAULT 'default',
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'thing',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pgmem_entities_namespace_name_key UNIQUE (namespace, name)
);

CREATE TABLE IF NOT EXISTS pgmem_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace text NOT NULL DEFAULT 'default',
  source_id uuid NOT NULL REFERENCES pgmem_entities(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES pgmem_entities(id) ON DELETE CASCADE,
  relation text NOT NULL,
  weight real NOT NULL DEFAULT 1.0 CHECK (weight > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pgmem_edges_namespace_src_rel_tgt_key UNIQUE (namespace, source_id, relation, target_id)
);

CREATE TABLE IF NOT EXISTS pgmem_memory_entities (
  memory_id uuid NOT NULL REFERENCES pgmem_memories(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES pgmem_entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);

CREATE INDEX IF NOT EXISTS pgmem_memories_namespace_idx
  ON pgmem_memories (namespace, created_at);
CREATE INDEX IF NOT EXISTS pgmem_memories_embedding_idx
  ON pgmem_memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS pgmem_edges_source_idx ON pgmem_edges (source_id);
CREATE INDEX IF NOT EXISTS pgmem_edges_target_idx ON pgmem_edges (target_id);
CREATE INDEX IF NOT EXISTS pgmem_memory_entities_entity_idx
  ON pgmem_memory_entities (entity_id);

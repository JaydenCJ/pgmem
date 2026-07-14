import { PgMemError } from "./errors.js";

/** Dimension used by the canonical files in sql/ (OpenAI text-embedding-3-small). */
export const DEFAULT_DIMENSIONS = 1536;

/** pgvector's HNSW index supports at most 2000 dimensions. */
const HNSW_MAX_DIMENSIONS = 2000;

export function assertValidDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16000) {
    throw new PgMemError(`embedding dimensions must be an integer in [1, 16000], got ${dimensions}`);
  }
}

/**
 * DDL for the pgmem tables and indexes, parameterized by embedding dimension.
 * The canonical copy generated with the default dimension lives in
 * sql/001_schema.sql; a test keeps the two in sync byte for byte.
 */
export function buildSchemaSql(dimensions: number = DEFAULT_DIMENSIONS): string {
  assertValidDimensions(dimensions);
  const hnswIndex =
    dimensions <= HNSW_MAX_DIMENSIONS
      ? `CREATE INDEX IF NOT EXISTS pgmem_memories_embedding_idx
  ON pgmem_memories USING hnsw (embedding vector_cosine_ops);
`
      : `-- HNSW omitted: pgvector's hnsw index supports at most ${HNSW_MAX_DIMENSIONS} dimensions.
-- Sequential re-ranking still works; consider reducing embedding dimensions.
`;
  return `-- pgmem schema, generated for vector(${dimensions}).
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
  embedding vector(${dimensions}) NOT NULL,
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
${hnswIndex}CREATE INDEX IF NOT EXISTS pgmem_edges_source_idx ON pgmem_edges (source_id);
CREATE INDEX IF NOT EXISTS pgmem_edges_target_idx ON pgmem_edges (target_id);
CREATE INDEX IF NOT EXISTS pgmem_memory_entities_entity_idx
  ON pgmem_memory_entities (entity_id);
`;
}

/**
 * Ranking functions. Written as PostgreSQL 14+ standard SQL function bodies
 * (RETURN expression) so they are auditable and dollar-quote free.
 * The canonical copy lives in sql/002_functions.sql.
 */
export function buildFunctionsSql(): string {
  return `-- pgmem ranking functions.

-- Exponential recency decay: 1.0 at event_time = now(), 0.5 one half-life
-- later, 0.25 after two half-lives. 0.6931471805599453 is ln(2).
CREATE OR REPLACE FUNCTION pgmem_decay_factor(event_time timestamptz, half_life_hours double precision)
RETURNS double precision
LANGUAGE SQL STABLE
RETURN exp(-0.6931471805599453
           * greatest(extract(epoch FROM (now() - event_time))::double precision, 0.0)
           / (half_life_hours * 3600.0));

-- Combined memory score: cosine similarity x recency decay x importance.
CREATE OR REPLACE FUNCTION pgmem_score(memory_embedding vector, query_embedding vector, last_accessed_at timestamptz, importance real, half_life_hours double precision)
RETURNS double precision
LANGUAGE SQL STABLE
RETURN (1.0 - (memory_embedding <=> query_embedding))
       * pgmem_decay_factor(last_accessed_at, half_life_hours)
       * importance::double precision;
`;
}

/** Full migration: schema followed by functions. Idempotent. */
export function buildMigrationSql(dimensions: number = DEFAULT_DIMENSIONS): string {
  return `${buildSchemaSql(dimensions)}\n${buildFunctionsSql()}`;
}

/**
 * Split a SQL script into individual statements on top-level semicolons.
 * Understands line comments, nested block comments, single/double quotes,
 * and dollar-quoted strings, so it is safe for the pgmem migration files.
 * Needed because some clients (e.g. PGlite's parameterized query path)
 * execute one statement per call.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i] as string;
    const next = i + 1 < n ? (sql[i + 1] as string) : "";

    // Line comment
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // Block comment (PostgreSQL block comments nest)
    if (ch === "/" && next === "*") {
      let depth = 0;
      const start = i;
      while (i < n) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else {
          i++;
        }
      }
      if (depth !== 0) throw new PgMemError("unterminated block comment in SQL script");
      current += sql.slice(start, i);
      continue;
    }

    // Single-quoted string ('' escapes a quote)
    if (ch === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      current += sql.slice(start, i);
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      const start = i;
      i++;
      while (i < n && sql[i] !== '"') i++;
      if (i >= n) throw new PgMemError("unterminated quoted identifier in SQL script");
      i++;
      current += sql.slice(start, i);
      continue;
    }

    // Dollar-quoted string: $tag$ ... $tag$
    if (ch === "$") {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) throw new PgMemError("unterminated dollar-quoted string in SQL script");
        const stop = close + tag.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0 && !isOnlyComments(trimmed)) statements.push(trimmed);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const tail = current.trim();
  // A trailing fragment without a semicolon still counts as a statement,
  // unless it is only comments.
  if (tail.length > 0 && !isOnlyComments(tail)) statements.push(tail);
  return statements;
}

function isOnlyComments(fragment: string): boolean {
  const stripped = fragment
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
  return stripped.length === 0;
}

/**
 * Minimal SQL client contract. It is intentionally the intersection of
 * `pg` (Pool / Client) and `@electric-sql/pglite`, so either can be passed
 * to {@link PgMem} without an adapter.
 */
export interface SqlQueryResult {
  rows: Array<Record<string, unknown>>;
}

/** Anything with a Postgres-style `query(sql, params)` method. */
export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<SqlQueryResult>;
}

/**
 * Pluggable embedding provider. pgmem never downloads or bundles a model:
 * you inject an embedder (an API client, a local model wrapper, or the
 * built-in deterministic HashEmbedder for tests and demos).
 */
export interface Embedder {
  /** Output vector length. Must match the vector(N) column created by migrate(). */
  readonly dimensions: number;
  /** Embed a batch of texts. Returns one vector of `dimensions` floats per text. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Reference to a graph entity by name; created on first use (upsert). */
export interface EntityRef {
  name: string;
  /** Free-form entity kind, e.g. "person", "project". Defaults to "thing". */
  kind?: string;
  metadata?: Record<string, unknown>;
}

/** A stored memory row. */
export interface Memory {
  id: string;
  namespace: string;
  content: string;
  importance: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  lastAccessedAt: Date;
  accessCount: number;
}

/** A memory returned by search(), with its ranking components. */
export interface SearchHit extends Memory {
  /** Cosine similarity in [-1, 1] between query and memory embeddings. */
  similarity: number;
  /** Final rank score: similarity x exponential time decay x importance. */
  score: number;
}

/** A graph entity row. */
export interface Entity {
  id: string;
  namespace: string;
  name: string;
  kind: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/** A directed, typed edge between two entities. */
export interface Edge {
  id: string;
  namespace: string;
  sourceId: string;
  targetId: string;
  relation: string;
  weight: number;
  createdAt: Date;
}

/** Subgraph returned by getGraph(). */
export interface Graph {
  /** Entities reachable from the root within the requested depth (root included). */
  nodes: Entity[];
  /** Edges whose both endpoints are inside `nodes`. */
  edges: Edge[];
  /** Memories attached (via add()'s `entities` option) to any node in the subgraph. */
  memories: Memory[];
}

/** Constructor options for {@link PgMem}. */
export interface PgMemOptions {
  /** Embedding provider. Required unless every call passes a precomputed `embedding`. */
  embedder: Embedder;
  /** Logical tenant/agent scope. All reads and writes are isolated per namespace. Default: "default". */
  namespace?: string;
  /** Default recency half-life in hours used by search() and decay(). Default: 168 (7 days). */
  halfLifeHours?: number;
}

/** Options for {@link PgMem.add}. */
export interface AddOptions {
  /** Relative importance multiplier, > 0. Default: 1. */
  importance?: number;
  metadata?: Record<string, unknown>;
  /** Entities mentioned by this memory; upserted and linked to it. */
  entities?: Array<EntityRef | string>;
  /** Precomputed embedding; skips the embedder for this call. */
  embedding?: number[];
}

/** Options for {@link PgMem.search}. */
export interface SearchOptions {
  /** Maximum hits to return. Default: 10. */
  limit?: number;
  /** Recency half-life in hours for this query. Default: PgMemOptions.halfLifeHours. */
  halfLifeHours?: number;
  /** Drop hits whose final score is below this value. */
  minScore?: number;
  /**
   * Candidate pool multiplier. The ANN index retrieves `limit * oversample`
   * nearest candidates, which are then re-ranked with decay and importance.
   * Default: 4.
   */
  oversample?: number;
  /** Update last_accessed_at / access_count for returned hits (reinforcement). Default: true. */
  touch?: boolean;
  /** Precomputed query embedding; skips the embedder for this call. */
  embedding?: number[];
}

/** Options for {@link PgMem.link}. */
export interface LinkOptions {
  /** Edge weight, > 0. Upserting an existing edge overwrites its weight. Default: 1. */
  weight?: number;
}

/** Options for {@link PgMem.getGraph}. */
export interface GraphOptions {
  /** Maximum number of edge hops from the root entity. Default: 2. */
  depth?: number;
  /** Maximum memories to include, newest first. Default: 100. */
  memoryLimit?: number;
}

/** Options for {@link PgMem.decay}. */
export interface DecayOptions {
  /** Half-life in hours used to compute decayed importance. Default: PgMemOptions.halfLifeHours. */
  halfLifeHours?: number;
  /** Memories whose importance x decay falls below this are pruned. Default: 0.05. */
  threshold?: number;
  /** Count matching memories without deleting them. Default: false. */
  dryRun?: boolean;
}

/** Result of {@link PgMem.decay}. */
export interface DecayResult {
  /** Number of memories deleted (or that would be deleted when dryRun is true). */
  pruned: number;
  dryRun: boolean;
}

/** Result of {@link PgMem.add}. */
export interface AddResult extends Memory {
  /** Entities upserted and linked to this memory (in input order). */
  entities: Entity[];
}

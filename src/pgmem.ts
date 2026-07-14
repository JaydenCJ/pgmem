import { PgMemError } from "./errors.js";
import { assertValidDimensions, buildMigrationSql, splitSqlStatements } from "./schema.js";
import type {
  AddOptions,
  AddResult,
  DecayOptions,
  DecayResult,
  Edge,
  Embedder,
  Entity,
  EntityRef,
  Graph,
  GraphOptions,
  LinkOptions,
  Memory,
  PgMemOptions,
  SearchHit,
  SearchOptions,
  SqlClient,
} from "./types.js";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DEFAULT_HALF_LIFE_HOURS = 168; // 7 days
const DEFAULT_DECAY_THRESHOLD = 0.05;

/**
 * Agent memory engine on top of a single Postgres database with the pgvector
 * extension: vector similarity, an entity graph, and temporal decay ranking.
 *
 * The constructor performs no I/O; the first call that touches the database
 * verifies that migrate() has been run and that the stored embedding
 * dimension matches the injected embedder.
 */
export class PgMem {
  private readonly client: SqlClient;
  private readonly embedder: Embedder;
  private readonly namespace: string;
  private readonly halfLifeHours: number;
  private ready = false;

  constructor(client: SqlClient, options: PgMemOptions) {
    if (typeof client?.query !== "function") {
      throw new PgMemError("client must expose query(sql, params) — pg.Pool, pg.Client, and PGlite all do");
    }
    if (typeof options?.embedder?.embed !== "function") {
      throw new PgMemError("options.embedder is required (use HashEmbedder for tests/demos)");
    }
    assertValidDimensions(options.embedder.dimensions);
    this.client = client;
    this.embedder = options.embedder;
    this.namespace = options.namespace ?? "default";
    this.halfLifeHours = options.halfLifeHours ?? DEFAULT_HALF_LIFE_HOURS;
    assertPositiveFinite(this.halfLifeHours, "halfLifeHours");
    if (this.namespace.length === 0) throw new PgMemError("namespace must be a non-empty string");
  }

  /**
   * Create the pgmem tables, indexes, and ranking functions (idempotent).
   * The embedding column is sized from the injected embedder's dimensions.
   * Fails with a clear error if the database was previously migrated with a
   * different dimension.
   */
  async migrate(): Promise<void> {
    const dims = this.embedder.dimensions;
    for (const statement of splitSqlStatements(buildMigrationSql(dims))) {
      await this.client.query(statement);
    }
    await this.client.query(
      `INSERT INTO pgmem_meta (key, value) VALUES ('embedding_dimensions', $1)
       ON CONFLICT (key) DO NOTHING`,
      [String(dims)],
    );
    await this.assertStoredDimensions();
    this.ready = true;
  }

  /**
   * Store one memory. The content is embedded via the injected embedder
   * unless a precomputed embedding is supplied. Optional entities are
   * upserted by (namespace, name) and linked to the memory.
   */
  async add(content: string, options: AddOptions = {}): Promise<AddResult> {
    await this.ensureReady();
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new PgMemError("content must be a non-empty string");
    }
    const importance = options.importance ?? 1;
    assertPositiveFinite(importance, "importance");
    const embedding = options.embedding ?? (await this.embedText(content));
    const vector = this.toVectorLiteral(embedding);
    const metadata = JSON.stringify(options.metadata ?? {});

    const { rows } = await this.client.query(
      `INSERT INTO pgmem_memories (namespace, content, embedding, importance, metadata)
       VALUES ($1, $2, $3::vector, $4, $5::jsonb)
       RETURNING id, namespace, content, importance, metadata, created_at, last_accessed_at, access_count`,
      [this.namespace, content, vector, importance, metadata],
    );
    const memory = mapMemory(first(rows, "INSERT .. RETURNING produced no row"));

    const entities: Entity[] = [];
    for (const ref of normalizeRefs(options.entities ?? [])) {
      const entity = await this.upsertEntity(ref);
      await this.client.query(
        `INSERT INTO pgmem_memory_entities (memory_id, entity_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [memory.id, entity.id],
      );
      entities.push(entity);
    }
    return { ...memory, entities };
  }

  /**
   * Rank memories by cosine similarity x exponential recency decay x
   * importance. Retrieval is two-phase: the pgvector index narrows to
   * `limit * oversample` nearest candidates, then the SQL scoring function
   * re-ranks them. Returned hits are "touched" (last_accessed_at bumped)
   * unless `touch: false`; the returned rows show pre-touch values.
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    await this.ensureReady();
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new PgMemError("query must be a non-empty string");
    }
    const limit = options.limit ?? 10;
    assertIntInRange(limit, 1, 1000, "limit");
    const oversample = options.oversample ?? 4;
    assertIntInRange(oversample, 1, 100, "oversample");
    const halfLifeHours = options.halfLifeHours ?? this.halfLifeHours;
    assertPositiveFinite(halfLifeHours, "halfLifeHours");
    const embedding = options.embedding ?? (await this.embedText(query));
    const vector = this.toVectorLiteral(embedding);

    const params: unknown[] = [vector, this.namespace, Math.max(limit * oversample, limit), halfLifeHours];
    let sql = `
      WITH candidates AS (
        SELECT id, namespace, content, embedding, importance, metadata, created_at, last_accessed_at, access_count
        FROM pgmem_memories
        WHERE namespace = $2
        ORDER BY embedding <=> $1::vector
        LIMIT $3
      ), scored AS (
        SELECT id, namespace, content, importance, metadata, created_at, last_accessed_at, access_count,
               (1.0 - (embedding <=> $1::vector))::double precision AS similarity,
               pgmem_score(embedding, $1::vector, last_accessed_at, importance, $4) AS score
        FROM candidates
      )
      SELECT * FROM scored
    `;
    if (options.minScore !== undefined) {
      assertFinite(options.minScore, "minScore");
      params.push(options.minScore);
      sql += ` WHERE score >= $${params.length}`;
    }
    params.push(limit);
    sql += ` ORDER BY score DESC, id LIMIT $${params.length}`;

    const { rows } = await this.client.query(sql, params);
    const hits = rows.map(mapHit);

    if ((options.touch ?? true) && hits.length > 0) {
      await this.client.query(
        `UPDATE pgmem_memories
         SET last_accessed_at = now(), access_count = access_count + 1
         WHERE id = ANY($1::uuid[])`,
        [toUuidArrayLiteral(hits.map((h) => h.id))],
      );
    }
    return hits;
  }

  /**
   * Create (or re-weight) a directed, typed edge between two entities.
   * Entities are upserted by name; linking the same
   * (source, relation, target) again overwrites the edge weight.
   */
  async link(source: EntityRef | string, relation: string, target: EntityRef | string, options: LinkOptions = {}): Promise<Edge> {
    await this.ensureReady();
    if (typeof relation !== "string" || relation.trim().length === 0) {
      throw new PgMemError("relation must be a non-empty string");
    }
    const weight = options.weight ?? 1;
    assertPositiveFinite(weight, "weight");
    const [src] = normalizeRefs([source]);
    const [tgt] = normalizeRefs([target]);
    const sourceEntity = await this.upsertEntity(src as EntityRef);
    const targetEntity = await this.upsertEntity(tgt as EntityRef);

    const { rows } = await this.client.query(
      `INSERT INTO pgmem_edges (namespace, source_id, target_id, relation, weight)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ON CONSTRAINT pgmem_edges_namespace_src_rel_tgt_key
       DO UPDATE SET weight = EXCLUDED.weight
       RETURNING id, namespace, source_id, target_id, relation, weight, created_at`,
      [this.namespace, sourceEntity.id, targetEntity.id, relation, weight],
    );
    return mapEdge(first(rows, "edge upsert produced no row"));
  }

  /**
   * Breadth-first subgraph around an entity: all entities within `depth`
   * edge hops (edges are traversed in both directions), the edges among
   * them, and the memories attached to any of those entities (newest
   * first). Returns an empty graph if the root entity does not exist.
   */
  async getGraph(entityName: string, options: GraphOptions = {}): Promise<Graph> {
    await this.ensureReady();
    if (typeof entityName !== "string" || entityName.trim().length === 0) {
      throw new PgMemError("entityName must be a non-empty string");
    }
    const depth = options.depth ?? 2;
    assertIntInRange(depth, 0, 32, "depth");
    const memoryLimit = options.memoryLimit ?? 100;
    assertIntInRange(memoryLimit, 0, 10000, "memoryLimit");

    const walk = await this.client.query(
      `WITH RECURSIVE walk (id, depth) AS (
         SELECT e.id, 0 FROM pgmem_entities e WHERE e.namespace = $1 AND e.name = $2
         UNION
         SELECT CASE WHEN ed.source_id = w.id THEN ed.target_id ELSE ed.source_id END, w.depth + 1
         FROM pgmem_edges ed
         JOIN walk w ON ed.source_id = w.id OR ed.target_id = w.id
         WHERE w.depth < $3 AND ed.namespace = $1
       )
       SELECT DISTINCT id::text AS id FROM walk`,
      [this.namespace, entityName, depth],
    );
    const ids = walk.rows.map((r) => String(r.id));
    if (ids.length === 0) return { nodes: [], edges: [], memories: [] };
    const idArray = toUuidArrayLiteral(ids);

    const nodes = await this.client.query(
      `SELECT id, namespace, name, kind, metadata, created_at
       FROM pgmem_entities WHERE id = ANY($1::uuid[]) ORDER BY created_at, id`,
      [idArray],
    );
    const edges = await this.client.query(
      `SELECT id, namespace, source_id, target_id, relation, weight, created_at
       FROM pgmem_edges
       WHERE namespace = $2 AND source_id = ANY($1::uuid[]) AND target_id = ANY($1::uuid[])
       ORDER BY created_at, id`,
      [idArray, this.namespace],
    );
    const memories =
      memoryLimit === 0
        ? { rows: [] }
        : await this.client.query(
            `SELECT DISTINCT m.id, m.namespace, m.content, m.importance, m.metadata,
                    m.created_at, m.last_accessed_at, m.access_count
             FROM pgmem_memories m
             JOIN pgmem_memory_entities me ON me.memory_id = m.id
             WHERE me.entity_id = ANY($1::uuid[])
             ORDER BY m.created_at DESC, m.id
             LIMIT $2`,
            [idArray, memoryLimit],
          );

    return {
      nodes: nodes.rows.map(mapEntity),
      edges: edges.rows.map(mapEdge),
      memories: memories.rows.map(mapMemory),
    };
  }

  /**
   * Maintenance: prune memories whose decayed importance
   * (importance x pgmem_decay_factor(last_accessed_at, halfLifeHours))
   * has fallen below `threshold`. Frequently searched memories are kept
   * alive because search() refreshes last_accessed_at. Use `dryRun: true`
   * to count without deleting.
   */
  async decay(options: DecayOptions = {}): Promise<DecayResult> {
    await this.ensureReady();
    const halfLifeHours = options.halfLifeHours ?? this.halfLifeHours;
    assertPositiveFinite(halfLifeHours, "halfLifeHours");
    const threshold = options.threshold ?? DEFAULT_DECAY_THRESHOLD;
    assertPositiveFinite(threshold, "threshold");
    const dryRun = options.dryRun ?? false;

    if (dryRun) {
      const { rows } = await this.client.query(
        `SELECT count(*)::int AS n FROM pgmem_memories
         WHERE namespace = $1
           AND importance::double precision * pgmem_decay_factor(last_accessed_at, $2) < $3`,
        [this.namespace, halfLifeHours, threshold],
      );
      return { pruned: asNumber(first(rows, "count produced no row").n), dryRun: true };
    }
    const { rows } = await this.client.query(
      `DELETE FROM pgmem_memories
       WHERE namespace = $1
         AND importance::double precision * pgmem_decay_factor(last_accessed_at, $2) < $3
       RETURNING id`,
      [this.namespace, halfLifeHours, threshold],
    );
    return { pruned: rows.length, dryRun: false };
  }

  // ---------------------------------------------------------------- private

  private async embedText(text: string): Promise<number[]> {
    const vectors = await this.embedder.embed([text]);
    const vector = vectors[0];
    if (!Array.isArray(vector)) throw new PgMemError("embedder.embed() must return one vector per input text");
    return vector;
  }

  private toVectorLiteral(embedding: number[]): string {
    if (!Array.isArray(embedding) || embedding.length !== this.embedder.dimensions) {
      throw new PgMemError(
        `embedding must have ${this.embedder.dimensions} dimensions (embedder setting), got ${Array.isArray(embedding) ? embedding.length : typeof embedding}`,
      );
    }
    for (const v of embedding) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new PgMemError("embedding values must be finite numbers");
      }
    }
    return `[${embedding.join(",")}]`;
  }

  private async upsertEntity(ref: EntityRef): Promise<Entity> {
    const { rows } = await this.client.query(
      `INSERT INTO pgmem_entities (namespace, name, kind, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (namespace, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, namespace, name, kind, metadata, created_at`,
      [this.namespace, ref.name, ref.kind ?? "thing", JSON.stringify(ref.metadata ?? {})],
    );
    return mapEntity(first(rows, "entity upsert produced no row"));
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    await this.assertStoredDimensions();
    this.ready = true;
  }

  private async assertStoredDimensions(): Promise<void> {
    let rows: Array<Record<string, unknown>>;
    try {
      ({ rows } = await this.client.query(`SELECT value FROM pgmem_meta WHERE key = 'embedding_dimensions'`));
    } catch (err) {
      throw new PgMemError(
        `could not read pgmem_meta — run migrate() (or apply sql/001_schema.sql + sql/002_functions.sql) first. Underlying error: ${errorMessage(err)}`,
      );
    }
    const stored = rows[0]?.value;
    if (stored === undefined) {
      throw new PgMemError("pgmem_meta has no embedding_dimensions row — run migrate() to initialize it");
    }
    const dims = this.embedder.dimensions;
    if (String(stored) !== String(dims)) {
      throw new PgMemError(
        `embedding dimension mismatch: database was migrated with ${String(stored)}, but the injected embedder produces ${dims}. Use a matching embedder or migrate a fresh database.`,
      );
    }
  }
}

// -------------------------------------------------------------------- utils

function normalizeRefs(refs: Array<EntityRef | string>): EntityRef[] {
  const byName = new Map<string, EntityRef>();
  for (const raw of refs) {
    const ref: EntityRef = typeof raw === "string" ? { name: raw } : raw;
    if (typeof ref.name !== "string" || ref.name.trim().length === 0) {
      throw new PgMemError("entity name must be a non-empty string");
    }
    if (!byName.has(ref.name)) byName.set(ref.name, ref);
  }
  return [...byName.values()];
}

function toUuidArrayLiteral(ids: string[]): string {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new PgMemError(`invalid uuid: ${id}`);
  }
  return `{${ids.join(",")}}`;
}

function first(rows: Array<Record<string, unknown>>, message: string): Record<string, unknown> {
  const row = rows[0];
  if (row === undefined) throw new PgMemError(message);
  return row;
}

function asDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") return new Date(v);
  throw new PgMemError(`expected a timestamp, got ${typeof v}`);
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  throw new PgMemError(`expected a number, got ${typeof v}`);
}

function asMetadata(v: unknown): Record<string, unknown> {
  if (v !== null && typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") return JSON.parse(v) as Record<string, unknown>;
  throw new PgMemError(`expected jsonb metadata, got ${typeof v}`);
}

function mapMemory(row: Record<string, unknown>): Memory {
  return {
    id: String(row.id),
    namespace: String(row.namespace),
    content: String(row.content),
    importance: asNumber(row.importance),
    metadata: asMetadata(row.metadata),
    createdAt: asDate(row.created_at),
    lastAccessedAt: asDate(row.last_accessed_at),
    accessCount: asNumber(row.access_count),
  };
}

function mapHit(row: Record<string, unknown>): SearchHit {
  return {
    ...mapMemory(row),
    similarity: asNumber(row.similarity),
    score: asNumber(row.score),
  };
}

function mapEntity(row: Record<string, unknown>): Entity {
  return {
    id: String(row.id),
    namespace: String(row.namespace),
    name: String(row.name),
    kind: String(row.kind),
    metadata: asMetadata(row.metadata),
    createdAt: asDate(row.created_at),
  };
}

function mapEdge(row: Record<string, unknown>): Edge {
  return {
    id: String(row.id),
    namespace: String(row.namespace),
    sourceId: String(row.source_id),
    targetId: String(row.target_id),
    relation: String(row.relation),
    weight: asNumber(row.weight),
    createdAt: asDate(row.created_at),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertPositiveFinite(v: number, name: string): void {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new PgMemError(`${name} must be a finite number > 0, got ${String(v)}`);
  }
}

function assertFinite(v: number, name: string): void {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new PgMemError(`${name} must be a finite number, got ${String(v)}`);
  }
}

function assertIntInRange(v: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new PgMemError(`${name} must be an integer in [${min}, ${max}], got ${String(v)}`);
  }
}

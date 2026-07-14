import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashEmbedder, PgMem, PgMemError } from "pgmem";

// Integration tests against a real in-process Postgres (PGlite) with the
// real pgvector extension — no mocks in the SQL path.

const embedder = new HashEmbedder(256);

describe("PgMem integration (PGlite + pgvector)", () => {
  let db: PGlite;
  let mem: PgMem;

  beforeAll(async () => {
    db = new PGlite({ extensions: { vector } });
    mem = new PgMem(db, { embedder });
    await mem.migrate();
  });

  afterAll(async () => {
    await db.close();
  });

  it("migrate() is idempotent", async () => {
    await mem.migrate();
    const { rows } = await db.query(`SELECT value FROM pgmem_meta WHERE key = 'embedding_dimensions'`);
    expect(rows).toEqual([{ value: "256" }]);
  });

  it("add() stores a memory with metadata and linked entities", async () => {
    const added = await mem.add("Mika prefers oat-milk lattes in the morning", {
      importance: 2,
      metadata: { source: "chat-42" },
      entities: [{ name: "Mika", kind: "person" }, "oat-milk latte"],
    });
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(added.importance).toBe(2);
    expect(added.metadata).toEqual({ source: "chat-42" });
    expect(added.accessCount).toBe(0);
    expect(added.entities.map((e) => e.name)).toEqual(["Mika", "oat-milk latte"]);
    expect(added.entities[0]?.kind).toBe("person");
    expect(added.entities[1]?.kind).toBe("thing");
  });

  it("search() returns the semantically-closest memory first with similarity and score", async () => {
    await mem.add("the deploy pipeline runs on port 8443 behind nginx");
    const hits = await mem.search("what does Mika drink in the morning?", { limit: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.content).toContain("oat-milk lattes");
    expect(hits[0]?.similarity).toBeGreaterThan(hits[1]?.similarity as number);
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("search() touches returned memories (access_count + last_accessed_at)", async () => {
    const before = await db.query(
      `SELECT access_count FROM pgmem_memories WHERE content LIKE 'Mika prefers%'`,
    );
    const hits = await mem.search("Mika morning drink", { limit: 1 });
    expect(hits).toHaveLength(1);
    const after = await db.query(
      `SELECT access_count FROM pgmem_memories WHERE content LIKE 'Mika prefers%'`,
    );
    const beforeCount = (before.rows[0] as { access_count: number }).access_count;
    const afterCount = (after.rows[0] as { access_count: number }).access_count;
    expect(afterCount).toBe(beforeCount + 1);
  });

  it("search({ touch: false }) leaves access counters untouched", async () => {
    const before = await db.query(`SELECT sum(access_count)::int AS n FROM pgmem_memories`);
    await mem.search("anything at all", { touch: false });
    const after = await db.query(`SELECT sum(access_count)::int AS n FROM pgmem_memories`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("search() respects minScore", async () => {
    const hits = await mem.search("what does Mika drink in the morning?", { minScore: 1e9 });
    expect(hits).toEqual([]);
  });
});

describe("temporal decay ranking", () => {
  let db: PGlite;
  let mem: PgMem;

  beforeAll(async () => {
    db = new PGlite({ extensions: { vector } });
    mem = new PgMem(db, { embedder });
    await mem.migrate();
  });

  afterAll(async () => {
    await db.close();
  });

  it("pgmem_decay_factor() halves once per half-life", async () => {
    const { rows } = await db.query(
      `SELECT pgmem_decay_factor(now() - interval '24 hours', 24.0) AS one,
              pgmem_decay_factor(now() - interval '48 hours', 24.0) AS two,
              pgmem_decay_factor(now(), 24.0) AS zero`,
    );
    const r = rows[0] as { one: number; two: number; zero: number };
    expect(r.zero).toBeCloseTo(1.0, 3);
    expect(r.one).toBeCloseTo(0.5, 3);
    expect(r.two).toBeCloseTo(0.25, 3);
  });

  it("ranks a fresh memory above an identical old one, by the decay ratio", async () => {
    const content = "backup job runs nightly at 02:00 UTC";
    const old = await mem.add(content);
    const fresh = await mem.add(content);
    await db.query(
      `UPDATE pgmem_memories
       SET created_at = now() - interval '72 hours', last_accessed_at = now() - interval '72 hours'
       WHERE id = $1`,
      [old.id],
    );
    const hits = await mem.search("when does the backup job run?", { halfLifeHours: 24, touch: false });
    expect(hits.map((h) => h.id)).toEqual([fresh.id, old.id]);
    const [top, bottom] = hits;
    // Same content => same similarity; the score gap is purely temporal:
    // 72h at a 24h half-life => factor 2^-3 = 0.125.
    expect(top?.similarity).toBeCloseTo(bottom?.similarity as number, 6);
    expect((bottom?.score as number) / (top?.score as number)).toBeCloseTo(0.125, 2);
  });

  it("weighs importance into the final score", async () => {
    const content = "the staging database password rotates weekly";
    const minor = await mem.add(content, { importance: 1 });
    const major = await mem.add(content, { importance: 5 });
    const hits = await mem.search("how often does the staging password rotate?", { touch: false, limit: 20 });
    const scoreOf = (id: string) => hits.find((h) => h.id === id)?.score as number;
    expect(scoreOf(major.id)).toBeGreaterThan(scoreOf(minor.id));
    expect(scoreOf(major.id) / scoreOf(minor.id)).toBeCloseTo(5, 1);
  });

  it("decay() prunes only memories whose decayed importance fell below the threshold", async () => {
    const keep = await mem.add("fresh and important operational note", { importance: 2 });
    const stale = await mem.add("stale trivia nobody asked about again", { importance: 1 });
    await db.query(
      `UPDATE pgmem_memories SET last_accessed_at = now() - interval '1000 hours' WHERE id = $1`,
      [stale.id],
    );
    // decayed importance of stale: 1 * 2^(-1000/24) ~= 0 < 0.05; keep stays at ~2.
    const dry = await mem.decay({ halfLifeHours: 24, dryRun: true });
    expect(dry).toEqual({ pruned: 1, dryRun: true });
    const wet = await mem.decay({ halfLifeHours: 24 });
    expect(wet).toEqual({ pruned: 1, dryRun: false });
    const { rows } = await db.query(`SELECT id::text AS id FROM pgmem_memories WHERE id IN ($1, $2)`, [
      keep.id,
      stale.id,
    ]);
    expect(rows).toEqual([{ id: keep.id }]);
    // Idempotent: nothing left to prune.
    expect(await mem.decay({ halfLifeHours: 24 })).toEqual({ pruned: 0, dryRun: false });
  });
});

describe("entity graph", () => {
  let db: PGlite;
  let mem: PgMem;

  beforeAll(async () => {
    db = new PGlite({ extensions: { vector } });
    mem = new PgMem(db, { embedder });
    await mem.migrate();
    await mem.link({ name: "alice", kind: "person" }, "works_at", { name: "acme", kind: "company" });
    await mem.link("acme", "located_in", { name: "tokyo", kind: "city" });
    await mem.link({ name: "bob", kind: "person" }, "works_at", "acme");
    await mem.add("Alice is leading the pgvector migration project", {
      entities: ["alice"],
    });
  });

  afterAll(async () => {
    await db.close();
  });

  it("link() upserts entities and overwrites edge weight on re-link", async () => {
    const e1 = await mem.link("alice", "mentors", "bob", { weight: 1 });
    const e2 = await mem.link("alice", "mentors", "bob", { weight: 3 });
    expect(e2.id).toBe(e1.id);
    expect(e2.weight).toBe(3);
    expect(e2.relation).toBe("mentors");
  });

  it("getGraph() at depth 1 returns direct neighbors only", async () => {
    const g = await mem.getGraph("tokyo", { depth: 1 });
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["acme", "tokyo"]);
    expect(g.edges.map((e) => e.relation)).toEqual(["located_in"]);
  });

  it("getGraph() at depth 2 walks edges in both directions", async () => {
    const g = await mem.getGraph("tokyo", { depth: 2 });
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["acme", "alice", "bob", "tokyo"]);
    const relations = g.edges.map((e) => e.relation).sort();
    expect(relations).toEqual(["located_in", "mentors", "works_at", "works_at"]);
  });

  it("getGraph() includes memories attached to subgraph entities", async () => {
    const g = await mem.getGraph("acme", { depth: 1 });
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["acme", "alice", "bob", "tokyo"]);
    expect(g.memories.map((m) => m.content)).toEqual(["Alice is leading the pgvector migration project"]);
  });

  it("getGraph() returns an empty graph for an unknown entity", async () => {
    expect(await mem.getGraph("nobody")).toEqual({ nodes: [], edges: [], memories: [] });
  });

  it("getGraph() at depth 0 returns just the root", async () => {
    const g = await mem.getGraph("alice", { depth: 0 });
    expect(g.nodes.map((n) => n.name)).toEqual(["alice"]);
    expect(g.edges).toEqual([]);
  });
});

describe("namespaces and guardrails", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite({ extensions: { vector } });
  });

  afterAll(async () => {
    await db.close();
  });

  it("isolates memories and graphs per namespace", async () => {
    const agentA = new PgMem(db, { embedder, namespace: "agent-a" });
    const agentB = new PgMem(db, { embedder, namespace: "agent-b" });
    await agentA.migrate();
    await agentA.add("agent A remembers the launch checklist", { entities: ["launch"] });
    await agentB.add("agent B remembers the billing incident", { entities: ["billing"] });

    const aHits = await agentA.search("what do you remember?", { touch: false });
    const bHits = await agentB.search("what do you remember?", { touch: false });
    expect(aHits.map((h) => h.content)).toEqual(["agent A remembers the launch checklist"]);
    expect(bHits.map((h) => h.content)).toEqual(["agent B remembers the billing incident"]);
    expect((await agentA.getGraph("billing")).nodes).toEqual([]);
  });

  it("fails with a readable error when migrate() was never run", async () => {
    const fresh = new PGlite({ extensions: { vector } });
    const m = new PgMem(fresh, { embedder });
    await expect(m.add("hello")).rejects.toThrow(/run migrate\(\)/);
    await fresh.close();
  });

  it("fails with a readable error on embedding dimension mismatch", async () => {
    const other = new PgMem(db, { embedder: new HashEmbedder(128) });
    await expect(other.add("hello")).rejects.toThrow(/dimension mismatch: database was migrated with 256/);
  });

  it("rejects a precomputed embedding of the wrong length", async () => {
    const m = new PgMem(db, { embedder });
    await expect(m.add("hello", { embedding: [1, 2, 3] })).rejects.toThrow(/256 dimensions/);
  });

  it("validates inputs without touching the database", () => {
    expect(() => new PgMem({} as never, { embedder })).toThrow(PgMemError);
    expect(() => new PgMem(db, {} as never)).toThrow(PgMemError);
    expect(() => new PgMem(db, { embedder, halfLifeHours: -1 })).toThrow(PgMemError);
    expect(() => new PgMem(db, { embedder, namespace: "" })).toThrow(PgMemError);
  });

  it("rejects nonsense options with readable errors", async () => {
    const m = new PgMem(db, { embedder });
    await expect(m.add("")).rejects.toThrow(/non-empty/);
    await expect(m.add("x", { importance: 0 })).rejects.toThrow(/importance/);
    await expect(m.search("")).rejects.toThrow(/non-empty/);
    await expect(m.search("x", { limit: 0 })).rejects.toThrow(/limit/);
    await expect(m.link("a", "", "b")).rejects.toThrow(/relation/);
    await expect(m.getGraph("a", { depth: -1 })).rejects.toThrow(/depth/);
    await expect(m.decay({ threshold: 0 })).rejects.toThrow(/threshold/);
  });
});

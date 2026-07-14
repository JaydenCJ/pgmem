// Smoke test for the built package: exercises the full
// add -> search -> link -> getGraph -> decay flow from dist/index.js
// against a real in-process Postgres (PGlite) with the real pgvector
// extension. Every step self-asserts; scripts/smoke.sh prints SMOKE OK
// only if this script exits 0.
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { HashEmbedder, PgMem } from "../dist/index.js";

const db = new PGlite({ extensions: { vector } });
const mem = new PgMem(db, { embedder: new HashEmbedder(256) });

await mem.migrate();
await mem.migrate(); // idempotency check
console.log("[smoke] migrate: schema + ranking functions applied, vector(256)");

const added = await mem.add("Mika prefers oat-milk lattes in the morning", {
  importance: 2,
  entities: [{ name: "Mika", kind: "person" }],
});
assert.match(added.id, /^[0-9a-f-]{36}$/);
assert.equal(added.importance, 2);
await mem.add("The deploy pipeline runs on port 8443 behind nginx");
console.log(`[smoke] add: 2 memories stored, first id=${added.id}`);

const hits = await mem.search("what does Mika drink in the morning?", { limit: 3 });
assert.ok(hits.length >= 2, "search should return both memories");
assert.ok(hits[0].content.includes("oat-milk lattes"), "closest memory must rank first");
assert.ok(hits[0].score > hits[1].score, "scores must be strictly ordered");
console.log(`[smoke] search: top hit "${hits[0].content}" score=${hits[0].score.toFixed(3)}`);

await mem.link("Mika", "works_at", { name: "acme", kind: "company" });
await mem.link("acme", "located_in", { name: "tokyo", kind: "city" });
const graph = await mem.getGraph("Mika", { depth: 2 });
assert.deepEqual(
  graph.nodes.map((n) => n.name).sort(),
  ["Mika", "acme", "tokyo"],
  "2-hop walk from Mika must reach acme and tokyo",
);
assert.equal(graph.edges.length, 2);
assert.ok(graph.memories[0].content.includes("oat-milk lattes"), "memory attached to Mika must surface");
console.log(`[smoke] graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.memories.length} memory`);

const stale = await mem.add("temporary scratch note", { importance: 1 });
await db.query(
  "UPDATE pgmem_memories SET last_accessed_at = now() - interval '1000 hours' WHERE id = $1",
  [stale.id],
);
const dry = await mem.decay({ halfLifeHours: 24, dryRun: true });
assert.deepEqual(dry, { pruned: 1, dryRun: true });
const wet = await mem.decay({ halfLifeHours: 24 });
assert.deepEqual(wet, { pruned: 1, dryRun: false });
console.log(`[smoke] decay: pruned ${wet.pruned} stale memory (dry-run agreed)`);

await db.close();
console.log("[smoke] all assertions passed");

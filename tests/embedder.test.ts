import { describe, expect, it } from "vitest";
import { HashEmbedder, PgMemError } from "pgmem";

function l2(v: number[]): number {
  return Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
}

function cosine(a: number[], b: number[]): number {
  return a.reduce((acc, x, i) => acc + x * (b[i] as number), 0);
}

describe("HashEmbedder", () => {
  it("is deterministic for the same input", async () => {
    const e = new HashEmbedder(64);
    const [a] = await e.embed(["the cat sat on the mat"]);
    const [b] = await e.embed(["the cat sat on the mat"]);
    expect(a).toEqual(b);
  });

  it("produces unit-length vectors of the configured dimension", async () => {
    const e = new HashEmbedder(128);
    const [v] = await e.embed(["hello world"]);
    expect(v).toHaveLength(128);
    expect(l2(v as number[])).toBeCloseTo(1, 6);
  });

  it("keeps batch order and embeds each text independently", async () => {
    const e = new HashEmbedder(64);
    const batch = await e.embed(["alpha", "beta"]);
    const [alpha] = await e.embed(["alpha"]);
    const [beta] = await e.embed(["beta"]);
    expect(batch[0]).toEqual(alpha);
    expect(batch[1]).toEqual(beta);
  });

  it("scores lexically overlapping texts closer than unrelated texts", async () => {
    const e = new HashEmbedder(256);
    const [query, related, unrelated] = await e.embed([
      "what does Mika drink in the morning?",
      "Mika prefers oat-milk lattes in the morning",
      "the deploy pipeline runs on port 8443",
    ]);
    expect(cosine(query as number[], related as number[])).toBeGreaterThan(
      cosine(query as number[], unrelated as number[]),
    );
  });

  it("returns a fixed unit basis vector for empty text", async () => {
    const e = new HashEmbedder(16);
    const [v] = await e.embed(["   "]);
    expect(v?.[0]).toBe(1);
    expect(l2(v as number[])).toBeCloseTo(1, 6);
  });

  it("rejects invalid dimensions", () => {
    expect(() => new HashEmbedder(0)).toThrow(PgMemError);
    expect(() => new HashEmbedder(3.5)).toThrow(PgMemError);
    expect(() => new HashEmbedder(20001)).toThrow(PgMemError);
  });
});

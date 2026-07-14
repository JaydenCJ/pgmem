import { PgMemError } from "./errors.js";
import type { Embedder } from "./types.js";

/** 32-bit FNV-1a hash over UTF-16 code units. */
function fnv1a(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Lowercased unicode word tokens plus adjacent-pair bigrams. */
function features(text: string): string[] {
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  const out = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i++) {
    out.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

/**
 * Deterministic, dependency-free embedder built on the feature-hashing trick:
 * each token and token bigram is hashed into one of `dimensions` signed
 * buckets, and the resulting vector is L2-normalized.
 *
 * It captures lexical overlap only (no semantics) and exists so that tests,
 * demos, and CI run with zero model downloads and zero network access.
 * For production quality, inject an {@link Embedder} backed by a real model.
 */
export class HashEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(dimensions = 256) {
    if (!Number.isInteger(dimensions) || dimensions < 8 || dimensions > 16000) {
      throw new PgMemError(`HashEmbedder dimensions must be an integer in [8, 16000], got ${dimensions}`);
    }
    this.dimensions = dimensions;
  }

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.embedOne(t)));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    for (const f of features(text)) {
      const bucket = fnv1a(f, 0x811c9dc5) % this.dimensions;
      const sign = (fnv1a(f, 0x01234567) & 1) === 0 ? 1 : -1;
      vec[bucket] = (vec[bucket] as number) + sign;
    }
    let norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
    if (norm === 0) {
      // Empty or all-separator text: fall back to a fixed unit basis vector
      // so cosine distance stays well defined.
      vec[0] = 1;
      norm = 1;
    }
    return vec.map((v) => v / norm);
  }
}

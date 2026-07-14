import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// Guarantees the README never lies: the Quickstart code block must be
// byte-identical to examples/quickstart.mts, and that exact file must run
// end to end against a real in-process Postgres.

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function extractQuickstartBlock(markdown: string): string {
  const match = /```ts\n([\s\S]*?)```/.exec(markdown);
  if (!match) throw new Error("no ```ts code block found in README.md");
  return match[1] as string;
}

describe("README quickstart example", () => {
  it("is byte-identical to examples/quickstart.mts in all three READMEs", () => {
    const example = read("../examples/quickstart.mts");
    for (const readme of ["../README.md", "../README.zh.md", "../README.ja.md"]) {
      expect(extractQuickstartBlock(read(readme))).toBe(example);
    }
  });

  it("stays within 10 lines of code", () => {
    const lines = read("../examples/quickstart.mts")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it("runs end to end and prints the expected memory", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await import("../examples/quickstart.mts");
      expect(log).toHaveBeenCalledTimes(1);
      const call = log.mock.calls[0] as unknown[];
      expect(call[0]).toBe("Mika prefers oat-milk lattes in the morning");
      expect(String(call[1])).toMatch(/^\(score 0\.\d{3}\)$/);
    } finally {
      log.mockRestore();
    }
  });
});

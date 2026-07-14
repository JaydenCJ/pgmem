import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIMENSIONS,
  PgMemError,
  buildFunctionsSql,
  buildMigrationSql,
  buildSchemaSql,
  splitSqlStatements,
} from "pgmem";

function readSqlFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../sql/${name}`, import.meta.url)), "utf8");
}

describe("schema builders", () => {
  it("sql/001_schema.sql matches buildSchemaSql(DEFAULT_DIMENSIONS) byte for byte", () => {
    expect(readSqlFile("001_schema.sql")).toBe(buildSchemaSql(DEFAULT_DIMENSIONS));
  });

  it("sql/002_functions.sql matches buildFunctionsSql() byte for byte", () => {
    expect(readSqlFile("002_functions.sql")).toBe(buildFunctionsSql());
  });

  it("parameterizes the vector dimension", () => {
    expect(buildSchemaSql(256)).toContain("embedding vector(256) NOT NULL");
    expect(buildSchemaSql(768)).toContain("embedding vector(768) NOT NULL");
  });

  it("includes an HNSW index up to 2000 dims and omits it above", () => {
    expect(buildSchemaSql(2000)).toContain("USING hnsw");
    expect(buildSchemaSql(2001)).not.toContain("USING hnsw");
  });

  it("rejects invalid dimensions", () => {
    expect(() => buildSchemaSql(0)).toThrow(PgMemError);
    expect(() => buildSchemaSql(1.5)).toThrow(PgMemError);
    expect(() => buildSchemaSql(16001)).toThrow(PgMemError);
  });

  it("produces a migration whose first statement creates the vector extension", () => {
    const statements = splitSqlStatements(buildMigrationSql(256));
    expect(statements.length).toBeGreaterThan(5);
    expect(statements[0]).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    // Both ranking functions must be present.
    const joined = statements.join("\n");
    expect(joined).toContain("pgmem_decay_factor");
    expect(joined).toContain("pgmem_score");
  });
});

describe("splitSqlStatements", () => {
  it("splits on top-level semicolons and trims whitespace", () => {
    expect(splitSqlStatements("SELECT 1;\n SELECT 2 ;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("keeps a trailing statement without a final semicolon", () => {
    expect(splitSqlStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons inside single-quoted strings, including '' escapes", () => {
    expect(splitSqlStatements("SELECT 'a;b'; SELECT 'it''s; fine';")).toEqual([
      "SELECT 'a;b'",
      "SELECT 'it''s; fine'",
    ]);
  });

  it("ignores semicolons inside quoted identifiers", () => {
    expect(splitSqlStatements('SELECT 1 AS "a;b";')).toEqual(['SELECT 1 AS "a;b"']);
  });

  it("ignores semicolons inside line and nested block comments", () => {
    const script = "SELECT 1; -- tail; comment\n/* outer ; /* inner ; */ still ; */ SELECT 2;";
    // Comments between statements stay attached to the following statement.
    expect(splitSqlStatements(script)).toEqual([
      "SELECT 1",
      "-- tail; comment\n/* outer ; /* inner ; */ still ; */ SELECT 2",
    ]);
  });

  it("ignores semicolons inside dollar-quoted strings", () => {
    const script = "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE SQL; SELECT 2;";
    expect(splitSqlStatements(script)).toEqual([
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE SQL",
      "SELECT 2",
    ]);
  });

  it("drops comment-only fragments", () => {
    expect(splitSqlStatements("-- just a comment\n")).toEqual([]);
    expect(splitSqlStatements("/* header */;\nSELECT 1;")).toEqual(["SELECT 1"]);
  });

  it("throws on unterminated constructs", () => {
    expect(() => splitSqlStatements("SELECT $tag$ oops")).toThrow(PgMemError);
    expect(() => splitSqlStatements("/* oops")).toThrow(PgMemError);
    expect(() => splitSqlStatements('SELECT "oops')).toThrow(PgMemError);
  });
});

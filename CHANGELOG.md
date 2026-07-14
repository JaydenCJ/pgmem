# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-08

### Added

- Postgres schema for agent memory: `pgmem_memories` (pgvector embedding
  column), `pgmem_entities` / `pgmem_edges` (knowledge graph),
  `pgmem_memory_entities` (memory-to-entity attachment), `pgmem_meta`
  (embedding dimension guard). Canonical DDL in `sql/001_schema.sql`.
- SQL ranking functions `pgmem_decay_factor` (exponential half-life decay)
  and `pgmem_score` (cosine similarity x decay x importance) in
  `sql/002_functions.sql`.
- TypeScript SDK with zero runtime dependencies: `PgMem` class with
  `migrate`, `add`, `search` (two-phase ANN retrieval + decay re-ranking),
  `link`, `getGraph` (recursive CTE walk), and `decay` (threshold pruning
  with dry-run mode).
- `Embedder` interface for caller-injected embeddings and a deterministic,
  dependency-free `HashEmbedder` for tests and demos.
- Namespace isolation for multi-agent / multi-tenant use.
- Integration test suite against a real in-process Postgres
  (PGlite + pgvector), plus unit tests for the SQL builders, statement
  splitter, and embedder.
- `docker-compose.yml` for a loopback-bound `pgvector/pgvector:pg16` server.
- Smoke script covering the full add -> search -> link -> getGraph -> decay
  flow from the built package entry.

[0.1.0]: https://github.com/JaydenCJ/pgmem

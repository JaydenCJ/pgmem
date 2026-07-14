# Contributing to pgmem

Thanks for considering a contribution. This project aims to stay small,
auditable, and dependency-free at runtime — please keep that spirit in mind.

## Development setup

```bash
git clone https://github.com/JaydenCJ/pgmem.git
cd pgmem
cd pgmem
npm install
npm test        # unit + integration tests (in-process Postgres via PGlite)
npm run build   # compile to dist/
npm run smoke   # end-to-end flow against the built package
```

No Docker is required for development: integration tests run against a real
in-process Postgres (PGlite) with the real pgvector extension. To test against
a server Postgres, start one with `docker compose up -d` (see `.env.example`).

## Ground rules

- **Zero runtime dependencies.** New runtime dependencies need a very strong
  case; dev dependencies are fine if they stay lightweight.
- **SQL is the product.** Schema or ranking changes go into `src/schema.ts`;
  regenerate the canonical files with the snippet below and keep the
  byte-equality test green. Rank-relevant changes need an integration test.

  ```bash
  node -e "import('./dist/schema.js').then(m => { const fs = require('node:fs'); fs.writeFileSync('sql/001_schema.sql', m.buildSchemaSql(m.DEFAULT_DIMENSIONS)); fs.writeFileSync('sql/002_functions.sql', m.buildFunctionsSql()); })"
  ```

- **Tests accompany code.** Bug fixes come with a regression test; features
  come with unit and (where they touch SQL) integration coverage.
- **English comments and messages** in source code and tests.
- **No model weights, no network in tests.** Embeddings stay behind the
  `Embedder` interface; tests use the deterministic `HashEmbedder`.

## Pull requests

1. Fork, create a topic branch, and keep the diff focused on one change.
2. Run `npm test && npm run build && npm run smoke` locally; all must pass.
3. Describe the behavior change and the reasoning, not just the diff.
4. Breaking API or schema changes: open an issue first to discuss migration.

## Reporting issues

Include the pgmem version, Postgres/pgvector versions (or PGlite version),
a minimal reproduction, and the full error output. For ranking oddities,
include the half-life, importance values, and timestamps involved — decay
math is time-sensitive by design.

---
name: dia-schema
description: Extract Dia SQL schemas and inferred JSON Schemas into an offline, searchable schema explorer using dia-tools. Use for full store structure, relationships, or schema UI requests.
---

Run the installed CLI, or `bun src/cli.ts` from its prepared checkout:

```sh
dia-tools schema extract --out artifacts/schema --open
```

For actual folder contents, URLs, and stored rows use `dia-tools explore --out artifacts/profiles --open` instead; that export contains private profile data. `schema extract` remains metadata-only.

Choose a fresh output directory. The extractor reads every `.db` directly in Dia User Data and its Default/Profile directories. Extensionless Chromium stores (History, Cookies, Login Data) and nested caches are outside this scope. Snapshots are independent, not globally atomic.

Deliver `dia-schema-explorer.html` plus `dia-schema-catalog.json`, `dia-json-schemas.json`, and `dia-sql-schema.sql`. The HTML is self-contained and works offline. It includes search, JSON field trees, SQL definitions, relationship links, and downloads.

Distinguish exact SQL metadata from observed JSON shapes. All parseable samples are checked against inferred schemas; this does not establish unobserved fields, required fields, or enum alternatives. Empty arrays and opaque payloads remain unknown. SQL row schemas are affinity projections, not complete SQLite constraint models. Select a definition from the JSON Schema library with a `$ref`; validating against the library root alone selects nothing.

Check extraction counts and per-database errors before claiming completion. A nonzero exit may leave a partial, clearly marked catalog. Metadata can contain user-defined key/property names and SQL defaults; review exports before sharing them. Never put extracted user catalogs into the project source or synthetic test fixtures.

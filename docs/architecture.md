# Architecture

## Encrypted stores

The supported derivation was observed in Dia 1.54.2. It is not a vendor compatibility guarantee.

1. Read `Dia Safe Storage` / account `Dia` through macOS's normal `security` Keychain authorization. Remove only its one trailing CLI newline.
2. Derive a 16-byte root with PBKDF2-HMAC-SHA1, salt `saltysalt`, 1,003 iterations.
3. The database context is UTF-8 `global/FAMILY` or `profile/PROFILE_DIRECTORY/FAMILY`, excluding `.db`.
4. HMAC-SHA256 the context with the public constant decoded from `iOe1Ue/XtonbieE/5m1nAgewvWQlePHRcKnoU10EyOM=` to produce an HKDF salt.
5. HKDF-SHA256 the root with that salt and context as info, output length 32.
6. Use SQLCipher's raw key syntax and its SQLCipher 4 defaults.

The public constant is not a secret. Keychain data and derived keys are never returned by CLI commands or persisted. Buffers are cleared where practical; JavaScript strings and runtime/native copies cannot guarantee complete memory erasure.

Bun's `Database.setCustomSQLite()` loads SQLCipher before any database is opened. Parameterized statements carry setting values and folder IDs; only validated fixed-length raw key bytes enter key setup SQL. No decrypted database file is written.

## Reads and writes

Snapshot the main file and WAL while inode/size/mtime/ctime stamps are unchanged before and after the copy. Use a private temporary directory. SQLite reconstructs SHM there. Verify SQLite integrity and SQLCipher page authentication. This is a best-effort stable interval with validation, not a global snapshot across database files.

A live write checks Dia's main process, validates the target location, creates an encrypted backup, checks the process again, and performs conditional updates in an immediate transaction. Integrity is checked before commit. This does not lock the operating system against the user launching Dia concurrently; keep Dia closed through the operation.

Folder plans store original and proposed icon metadata. Apply checks titles, active status, IDs, icons, and source values against the original snapshot, updates only icon fields, and verifies the results. Each database commits separately; receipts track progress. Backups retain the original context in a manifest. They are user data and never project assets.

## Folder icon representation

`tabs.db` contains `tab_groups`, joined to `nodes` by `node_id`. Active selection excludes nodes with `deleted_at`.

```json
{ "emoji": "📁" }
```

or

```json
{ "symbol": "folder" }
```

Both are stored as JSON text in `tab_groups.icon`. A user-selected icon uses `icon_source = "userGenerated"`. Native symbol identifiers are app-specific; matching a known reference is preferred to guessing unsupported names.

## Schema extraction

SQL DDL, columns (including generated columns), indexes, foreign keys, views, and triggers come from SQLite metadata. JSON inference scans all parseable text/BLOB values. Key/value stores infer each key separately; other tables merge shapes per column. Raw values, enum candidates, example values, and inferred required fields are omitted. Identifier-like property names are generalized into map shapes using `additionalProperties`.

Every observed parseable JSON value is validated against its inferred shape. Arrays with no elements and opaque binaries cannot establish element/payload shapes. Inference has a depth limit of 64, marked in the schema. Dynamic-key detection is heuristic: user-defined names may remain in schema metadata, so metadata is not guaranteed anonymous.

The JSON Schema library uses Draft 2020-12 with `$defs`. SQL row schemas project affinity into JSON; non-STRICT SQLite may store other storage classes. This is not a full constraint or insert/update model. SQL archives contain definitions from separate databases and should not be run as one migration.

## Profile and record explorer

`explore` adds stored rows and normalized profile trees to the catalog; `schema extract` remains metadata-only. Both use the same per-database encrypted snapshot for SQL metadata, values, and the tab tree. Selected profile display fields are loaded separately from `Local State`.

`nodes.parent_id` describes hierarchy. `tab_groups.node_id` identifies folder nodes, `tabs.node_id` identifies tabs, and `content_panes.node_id` links panes to their tab ancestry. `web_contents.content_pane_id` supplies page URLs and titles. The normalizer preserves order, propagates removed status and space membership through ancestors, breaks cycles for display, and surfaces orphaned nodes without discarding their records. The original sanitized rows remain available in the record browser.

Record cells use typed wrappers (`value`, `json`, `binary`, `redacted`, `truncated`) so omissions are distinguishable from nulls. All rows are exported unless the caller sets a row limit. Credential-like key/column names and nested JSON fields are masked; authentication databases are masked, URL credentials and known sensitive query/fragment parameters are stripped, opaque binary payloads are not embedded, and cells over 256 KiB are omitted. These rules are heuristic: an export still contains private titles, URLs, custom names, and other user data. It is not an anonymous report.

The frontend paginates tabs and table rows, supports sorting and filtering, and keeps profile data separate from schema-only exports. JSON embedding escapes HTML delimiters; user strings are escaped before rendering. Page anchors accept only HTTP(S). A restrictive Content Security Policy and inline assets keep the viewer offline until the user explicitly opens a link. There are no remote favicon/image requests or write endpoints.

## Portable build

The Bun executable embeds the UI and, in portable mode, SQLCipher and discovered non-system dylib dependencies. Build scripts rewrite library references to `@loader_path`, ad-hoc sign the copied libraries, and embed them as file assets. Startup extracts them to a private temporary directory before loading SQLCipher. Build and test natively for each target architecture. System libraries remain provided by macOS.

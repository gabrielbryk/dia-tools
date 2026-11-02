# dia-tools

A local TypeScript/Bun CLI for inspecting and editing Dia's encrypted browser stores on macOS. Includes offline profile, schema, and saved-tab usage viewers and nine agent skills.

- Discover profiles and encrypted databases.
- Read and patch typed settings, including individual JSON fields.
- Plan folder-icon changes using emojis, native symbols, or an existing folder as a reference.
- Explore full profile trees, spaces, folders, tab titles, split panes, and URLs in an offline UI.
- Browse searchable, sortable database records and their SQL / JSON schemas.
- Create validated encrypted backups.
- Plan hidden-feature overrides and Incoming Links routing rules with stale-state checks.
- Analyze saved-tab usage across Dia and Arc and prepare an evidence-based folder/space proposal.

Core stores were reverse-engineered against **Dia 1.54.2**; hidden-feature overrides and Incoming Links were examined on **1.55.1 (89833)**. This is an independent project, not an official Dia API. Store layouts and serialization can change between Dia versions. Runtime data stays local; there is no telemetry or network service.

## Run from source

Requires macOS, Dia, Bun 1.3.13 or newer, and SQLCipher 4:

```sh
brew install bun sqlcipher
bun install --frozen-lockfile
bun scripts/build-ui.ts
bun src/cli.ts doctor
bun src/cli.ts self-test
```

The first encrypted read may trigger a normal macOS Keychain prompt for `Dia Safe Storage`. The tool derives database keys in memory; it does not print them, store them, or pass them in process arguments.

## Build a bundled CLI

```sh
bun run build            # standalone Bun executable; uses installed SQLCipher
bun run build:portable   # embeds SQLCipher and its non-system native dependencies
```

Outputs are in `dist/`, named for the build machine's OS and architecture. The portable executable requires neither Bun nor Homebrew at runtime. Build on each architecture you intend to distribute; cross-compiling the Bun runtime alone would not cross-compile the native libraries. The build requires Homebrew SQLCipher and Apple's command-line tools (`otool`, `install_name_tool`, `codesign`). Portable libraries are extracted into a private temporary directory at startup and normally removed on exit.

Distribute the portable release archive with its license notices and skills. Local builds use ad-hoc signing; Apple Developer ID signing/notarization is a separate release step. Apple Silicon is locally verified. Intel builds need their own verification. GitHub Actions is disabled, and workflow examples are stored outside `.github/workflows/`.

## Commands

The examples below assume a built executable is available as `dia-tools`. From source, substitute `bun src/cli.ts`.

```sh
dia-tools stores
dia-tools settings list --profile Global
dia-tools settings get window_layout.preferences --type json
dia-tools sql-schema --profile Default --family tabs
dia-tools check --profile Default --family tabs
```

Profiles are directory names: `Global`, `Default`, `Profile 2`, etc. Global defaults to `global_key_value_store.db`; profile settings default to `key_value_store.db`. `--user-data PATH` selects a different User Data root. `--db PATH --context profile/Default/tabs` supports reading copied databases under their original encryption context.

### Edit a preference

```sh
# Dry run: read the current value and preview the proposed patch.
dia-tools settings patch window_layout.preferences preferredSidebarWidth 320

# Quit Dia normally, then apply the same change with an encrypted backup.
dia-tools settings patch window_layout.preferences preferredSidebarWidth 320 --write-live
```

`settings set KEY VALUE --type TYPE` replaces the whole stored value. Types: `bool`, `string`, `json`, `hex`, `int64`, `float64`. Numeric types are explicit little-endian byte encodings; length alone does not identify a BLOB's meaning. JSON patches require an existing object field and preserve unrelated properties. Creating a key requires `--create`.

### Enable a hidden feature

The observed Incoming Links gate uses a macOS preference override:

```sh
mkdir -p plans
dia-tools feature-flags list
dia-tools feature-flags plan external-link-destination-enabled true --out plans/feature.json
dia-tools feature-flags apply plans/feature.json  # preview only
# Review, then quit Dia normally.
dia-tools feature-flags apply plans/feature.json --write-live
# Reopen Dia and check Settings → Advanced → Incoming Links → Manage Rules.
dia-tools feature-flags verify plans/feature.json
```

The planner preserves unrelated overrides and the apply command refuses stale preferences. Backups for this operation are private JSON files containing the original override preference, not encrypted database copies. Use `feature-flags plan FLAG --remove --out FILE` to remove an override rather than explicitly set it to false. `--user-data` does not redirect macOS preferences; these commands target the current user's `company.thebrowser.dia` domain. Stored-state verification does not prove feature availability; inspect the native UI after restart. See the [hidden-features skill](skills/dia-hidden-features/SKILL.md) for discovery and rollback.

### Edit Incoming Links routing rules

```sh
dia-tools link-rules list
dia-tools link-rules plan plans/changes.json --out plans/routing.json
dia-tools link-rules apply plans/routing.json  # validate on an encrypted copy
# Review, then quit Dia normally.
dia-tools link-rules apply plans/routing.json --write-live
# Reopen Dia, verify persistence, and inspect the native rules editor.
dia-tools link-rules verify plans/routing.json
```

The changes file uses `upsert` and `remove` arrays. Each upsert contains `host`, `matchScope` (`exact_host` or `host_and_subdomains`), and a current `spaceID` from `link-rules list`. Removals contain only `host` and `matchScope`. Unspecified rules are preserved. The plan binds destination spaces and the complete original ruleset; apply rejects stale state and cross-space overlaps with unverified precedence. See the [link-rules skill](skills/dia-link-rules/SKILL.md) for a sample file, Arc migration, UI verification, and undo.

### Switch folder emojis to native folder symbols

```sh
mkdir -p plans
dia-tools folders list --profile all
dia-tools folders plan --profile all --from-emoji '📁' --symbol folder --out plans/folders.json

# Review the plan and quit Dia normally.
dia-tools folders apply plans/folders.json --write-live --receipt plans/folders-receipt.json

# Reopen Dia, then verify persistence.
dia-tools folders verify plans/folders.json
```

The default selection includes only active folders with 📁. Custom emojis and existing symbols are preserved. Use `--id EXACT_FOLDER_ID` for a single folder, or `--reference-id ID --reference-profile Default` to copy an existing icon. Symbol names are Dia-specific, not an assumed list of SF Symbols.

### Explore profiles, folders, and contents

```sh
dia-tools explore --out artifacts/profiles --open
```

The offline viewer includes:

- Profile display names, spaces, folders, favorites, pinned containers, and window contents.
- A folder tree and card/list views of tabs, including nested folders and split-view pages.
- Search across profiles, clickable HTTP(S) URLs, copy buttons, space/domain filters, and per-folder URL exports.
- A paginated record browser with value search, sortable columns, full-row JSON inspection, and links to SQL schemas.
- Removed-item visibility, empty states, and recovery of orphaned/cyclic tree relationships.

All rows in the discovered `.db` stores are included by default. Use `--row-limit 1000` to cap rows per table for large profiles; partial tables are clearly labeled. Credential-like fields are redacted, opaque binary cells show metadata, and values over 256 KiB are omitted. Redaction is heuristic, not a guarantee of anonymization. These exports contain personal browsing data and belong outside source control.

Profile names and account labels come from selected fields in `Local State`. Tabs and folders come from each profile's `tabs.db`; no external services or favicon servers are contacted. Only HTTP(S) page links can be opened, and only on a click. The viewer is read-only; rerun the export into a fresh directory to refresh it.

The output filename remains `dia-schema-explorer.html` for compatibility. Its companion catalog contains the profile data and records when generated by `explore`. The JSON Schema bundle and SQL archive remain structural metadata.

### Prioritize saved tabs and plan a layout

```sh
dia-tools usage --out artifacts/usage --timezone America/Chicago --open
# Dia history only:
dia-tools usage --no-arc --out artifacts/dia-only
```

The command writes `dia-usage.json` and a self-contained `dia-usage.html`. It inventories saved folders, standalone saved pins, and Favorites; ordinary window tabs and their groups do not enter the ranking. A saved page remains in scope even if currently open. Each tab counts once, including split tabs with several pages.

Local Arc history is included when profiles can be matched by unique display name. `--arc-user-data PATH` selects another Arc data root; `--arc-profile-map FILE` supplies a JSON object mapping Dia directory names to Arc directory names when names are ambiguous. Directory numbers alone do not establish a match. Unmatched profiles and source failures remain visible; partial reports exit nonzero.

Visit history supplies URL-level evidence, not tab-focus counts or time spent. Rank by distinct visited dates over 30 days, with visit counts, recency, and 90-day context. Exact saved-URL matches are separate from broader site activity. Cross-browser overlap is reported before combining evidence; imported history may have different timestamp precision. A missing match is not grounds to delete or archive a reference.

History reads use read-only SQLite transactions; encrypted saved-tab reads use validated snapshots. The viewer makes no network requests on load. Keep exports outside source control. This command does not rearrange the browser. Use the [`dia-layout` skill](skills/dia-layout/SKILL.md) to interpret the evidence and produce a proposed space/folder tree, quick-access shortlist, and source-folder ID mapping.

### Explore schemas

```sh
dia-tools schema extract --out artifacts/schema --open
```

Open `artifacts/schema/dia-schema-explorer.html` in any browser. Search across profiles, inspect columns and indexes, expand JSON field trees, navigate foreign-key relationships, and download schemas. All UI assets and the catalog are embedded in that HTML file.

The output includes a full catalog, a Draft 2020-12 JSON Schema library, and SQL definitions grouped by their original database. SQL metadata is extracted directly. JSON payload schemas describe observed examples; they are not vendor-authored contracts. Select a library `$defs` entry with `$ref` when validating a payload.

Scope: `.db` files directly in User Data and Default/Profile folders. Extensionless Chromium stores such as History, Cookies, and Login Data, and nested caches, are excluded. Empty tables, opaque binaries, and empty arrays can leave shapes unknown. Extraction errors remain visible and produce a nonzero exit status.

### Back up a store

```sh
dia-tools backup --profile Default --family tabs
```

The default destination is `~/Library/Application Support/dia-tools/backups`; use `--backup-dir PATH` to change it. Backups stay encrypted and retain WAL data plus a context manifest. There is no automatic whole-database restore command; restoring older stores can overwrite newer browsing state.

## Write behavior

Database reads operate on temporary encrypted snapshots. Live database writes require `--write-live` and a normal Dia shutdown, create a validated encrypted backup, use transactions, and reject stale values. Feature overrides instead use macOS preferences, with the same explicit-write/shutdown requirements, stale checks, and a private JSON preference backup. Folder plans preflight all selected profiles before editing. Transactions are per database; a multi-profile operation is not globally atomic. Its receipt records completed profiles and backup paths if a later profile fails. Do not blindly rerun a partially completed plan.

The tool does not force-quit Dia, disable system protections, patch the app, or attach a debugger. No changes are made merely by installing it or generating schemas. Dia may sync edits after reopening; cross-device sync behavior is not verified.

## Agent skills

The [`skills/`](skills/) directory contains standalone Agent Skills:

| Skill                                                        | Operation                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `dia-inspect`                                                | Locate stores, inspect keys and SQL, check integrity                  |
| `dia-settings`                                               | Patch or replace requested settings                                   |
| [`dia-hidden-features`](skills/dia-hidden-features/SKILL.md) | Discover, enable, and verify hidden features                          |
| [`dia-link-rules`](skills/dia-link-rules/SKILL.md)           | Plan, edit, and verify incoming-link routing by space                 |
| `dia-folder-icons`                                           | Plan, apply, and verify folder icons                                  |
| `dia-profile-explorer`                                       | Browse profile trees, folder URLs, and database records               |
| [`dia-layout`](skills/dia-layout/SKILL.md)                   | Analyze saved-tab usage and propose spaces, folders, and quick access |
| `dia-schema`                                                 | Export schemas and an offline explorer                                |
| `dia-backup`                                                 | Create encrypted backups                                              |

Install the desired skill folders into the skill directory supported by your agent. They expect `dia-tools` on PATH, or a prepared source checkout. Installation does not authorize unrelated changes; each skill preserves the user's requested scope.

## Develop and verify

```sh
bun run check
bunx playwright install chromium
bun run test:ui
bun run build:portable
dist/dia-tools-darwin-arm64-portable self-test
```

Tests use synthetic encrypted databases, never a developer's Keychain or real profile. They exercise context-specific key derivation, WAL snapshots, stale-write rejection, transaction rollback, folder selection, schema inference, privacy of exported examples, scoped flag merging, and routing conflicts and destination drift. `self-test` also uses synthetic data, so it can check an installed binary without Dia or Keychain access.

Project layout:

```text
src/crypto.ts       Keychain access and key derivation
src/store.ts        SQLCipher, snapshots, backups, write guards
src/settings.ts     Typed key/value edits and JSON patches
src/feature-flags.ts Scoped macOS feature overrides and preference backups
src/link-rules.ts   Incoming-link rule plans, conflict checks, verification
src/folders.ts      Folder plans, conflict checks, verification
src/schema.ts       SQL metadata and JSON Schema extraction
src/profile-data.ts Profile trees and redacted record extraction
src/ui/             TypeScript offline explorer and HTML template
scripts/            Bun builds and portable packaging
skills/             Agent workflows
tests/              Synthetic encrypted fixtures and tests
```

Generated runtime data belongs in ignored `artifacts/`, `plans/`, and backup directories. Do not commit real catalogs, folder plans, screenshots containing user data, Keychain material, or database files. Metadata exports can reveal custom key names and SQL defaults even though raw row values and secrets are omitted.

CI and release automation are disabled. Inactive examples are in [`docs/workflow-templates/`](docs/workflow-templates/); enabling them requires a deliberate later change.

See [architecture](docs/architecture.md) for implementation details and [release instructions](docs/releasing.md) for GitHub packaging. The project is MIT licensed; bundled dependencies retain their own licenses. Bun's [executable documentation](https://bun.com/docs/bundler/executables) describes its runtime and asset bundling.

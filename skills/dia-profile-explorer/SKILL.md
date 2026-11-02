---
name: dia-profile-explorer
description: Build an offline Dia profile viewer with folder trees, tab URLs, spaces, and searchable database records. Use when the user wants actual profile contents rather than schema metadata alone.
---

Run `dia-tools explore --out artifacts/profiles --open` from a prepared installation, or substitute `bun src/cli.ts` in the source checkout. Choose a fresh output directory. This is a read-only snapshot; Dia can remain open if stable snapshots succeed.

Deliver `dia-schema-explorer.html`. Its Profiles & contents view includes profile switching, display names, spaces, ordered folder trees, favorites, pinned containers, tab cards, split panes, titles, and URLs. Database records provides pagination, filtering, sorting, JSON inspection, and links to SQL definitions. Schemas & relationships retains the structural explorer.

All rows from directly discovered `.db` stores are included by default. `--row-limit N` produces a bounded export and marks partial tables; partial trees must not be described as complete. Extensionless Chromium history/cookie stores and nested caches are outside scope. Credentials are heuristically redacted, opaque binaries show metadata, and cells larger than 256 KiB are omitted. A profile export still contains private browsing data and should remain local unless the user explicitly requests sharing it.

Verify requested profiles/folders render, cross-check representative URL counts, and report extraction failures or row limits. Only click external URLs if the user's task calls for it; previewing the viewer itself requires no network requests. Do not commit profile catalogs, generated HTML, screenshots, or row exports to the source repository. Updating the viewer does not authorize editing live browser data or enabling CI.

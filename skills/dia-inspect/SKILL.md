---
name: dia-inspect
description: Inspect local Dia browser databases, profiles, settings keys, SQL definitions, and integrity using dia-tools. Use for discovery before an edit or investigating where a Dia preference is stored.
---

Use the installed `dia-tools` CLI; in a source checkout use `bun src/cli.ts` after `bun install` and `bun scripts/build-ui.ts`. `dia-tools doctor` checks SQLCipher without requesting Keychain access. Reading encrypted stores uses the normal macOS Keychain prompt.

Start with `dia-tools stores`. Global preferences usually live in `global_key_value_store.db`; profile preferences in `key_value_store.db`; folders in `tabs.db`. Profile names are directory names (`Default`, `Profile 2`), not display names.

Use `settings list --profile Global` to list keys without values. Read only relevant values with `settings get KEY --type json --profile Global`; formats also include bool, string, hex, int64, float64. Do not infer numeric BLOB encodings from byte length alone.

Use `sql-schema --profile Default --family tabs` and `check --profile Default --family tabs` for definitions and integrity. For an encrypted copy, pass `--db PATH --context profile/Default/tabs`; moving the file does not change its original derivation context.

Reads already use encrypted snapshots. Do not extract or print Keychain secrets, attach a debugger, patch Dia, or change app signing to read these stores. This workflow does not authorize changes. A present key is not evidence that editing it is a supported user preference.

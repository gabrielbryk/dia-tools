---
name: dia-settings
description: Change an explicitly requested Dia browser preference with dia-tools, including JSON field patches and typed key/value settings. Use for preference edits, not folder icon changes.
---

Use installed `dia-tools`, or `bun src/cli.ts` from its prepared checkout. Inspect the key with `settings get KEY --type json --profile Global` and its SQL layout when needed. Preserve the original profile and serialization. An enum may be an object such as `{"sidebar":{}}`, not a string.

Prefer `settings patch KEY FIELD JSON_VALUE --profile PROFILE` for an existing JSON object field. The default is a dry run. For example:

```sh
dia-tools settings patch window_layout.preferences preferredSidebarWidth 320
```

`settings set KEY VALUE --type TYPE` replaces the whole value. Supported types: bool, string, json, hex, int64, float64. Missing keys require `--create`; use it only when the requested setting and representation are established. Patching refuses missing paths and array traversal.

Once the requested change is concrete and authorized, apply the same command with `--write-live`. Existing user authorization is sufficient; do not ask again merely because the command writes. Dia must be closed normally. If it declines scripted quit, ask the user to quit; do not force-kill it. The CLI creates an encrypted backup and rejects stale values.

Reopen Dia when appropriate, reread the targeted value, and report whether persistence was verified. Do not claim a database value proves UI behavior or multi-device sync. Keep backup paths in the completion report; never commit backups or values to a source repository.

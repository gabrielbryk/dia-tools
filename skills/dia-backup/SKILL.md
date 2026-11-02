---
name: dia-backup
description: Create validated encrypted backups of selected Dia stores using dia-tools. Use for backup requests or preparation for database experiments; does not restore or overwrite stores.
---

Use `dia-tools backup --profile Default --family tabs` for folder storage, or `dia-tools backup --profile Global` for global settings. `--backup-dir PATH` selects the destination. Each backup includes the encrypted database, its WAL when present, and a manifest with original path and key-derivation context. Protect these files like the original browser data.

The CLI validates SQLite integrity and SQLCipher authentication. Reads and backups can operate while Dia runs using a stable copy interval; if activity prevents a snapshot, request a normal quit and retry. Every settings/folder live-write command already creates its own backup, so an extra backup is optional unless requested.

Verify a copied database with `dia-tools check --db BACKUP_DB --context ORIGINAL_CONTEXT`. Retain the original context even if the backup is moved or renamed. Do not print encryption keys or rewrite a backup as plaintext.

Report the exact backup path and validation result. The CLI deliberately has no automatic whole-database restore command: replacing tabs.db can discard newer browsing state. A restore request needs its own scoped recovery work, considering WAL files and intervening edits; this backup skill does not imply authorization to restore.

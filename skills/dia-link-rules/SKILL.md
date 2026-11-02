---
name: dia-link-rules
description: Inspect, propose, add, change, remove, and verify Dia Incoming Links routing rules by space on macOS. Use for Link Air Traffic Control rules, domain-to-space routing, or recovering Arc routing rules for migration. Use dia-hidden-features to expose the feature itself.
---

# Dia Link Rules

Use `dia-tools` with the `link-rules` command group, or `bun src/cli.ts` from a prepared dia-tools checkout. If installed via a symlink, resolve it to locate the checkout two directories above the skill. Distributed skills require a separately installed CLI. Check `link-rules --help`; rebuild older binaries when needed.

## Inspect and propose

Run `dia-tools doctor` and `dia-tools link-rules list`. The list includes current space IDs, titles, storage profiles, and rules from encrypted snapshots. Treat titles as display labels and IDs as destinations. Several spaces can share one storage profile; do not route by profile name or reuse remembered IDs.

Read [storage-and-matching.md](references/storage-and-matching.md) before planning. If the store or table is absent, inspect whether Incoming Links has been enabled and initialized by Dia. Use `dia-hidden-features` when enabling it is within the user's request; do not invent a database schema. For Arc migration, read [arc-migration.md](references/arc-migration.md).

Group proposed changes by destination space, showing host and scope. Prefer narrow hosts when different services belong to different spaces. Preserve unspecified existing rules. If asked only to propose, do not apply. Use existing authorization when the user has already accepted a concrete ruleset; ask only for unresolved destinations or broader scope.

## Prepare an executable plan

Create a local changes file with `upsert` and/or `remove` arrays. Replace the example destination with a freshly discovered space ID; examples are not executable rules for the user's browser.

```json
{
  "upsert": [
    {
      "host": "service.example.com",
      "matchScope": "exact_host",
      "spaceID": "REPLACE_WITH_CURRENT_SPACE_ID"
    }
  ],
  "remove": []
}
```

An upsert creates a rule or changes the destination for its `(host, matchScope)` key. Removal needs only `host` and `matchScope`; changing scope requires removing the old key and adding the new one. A fresh ruleset is not permission to delete every unspecified rule: enumerate the approved removals.

```sh
mkdir -p plans
dia-tools link-rules plan plans/changes.json --out plans/link-rules.json
dia-tools link-rules apply plans/link-rules.json
```

Use fresh filenames each time. Inspect the generated before/after arrays and destination mappings. The default apply runs the transaction on a disposable encrypted copy and verifies its integrity and complete resulting ruleset. Cross-space overlaps are rejected because rule precedence is not established, including overlaps already present in the proposed final state. Resolve them explicitly instead of guessing precedence.

## Apply and verify

After authorization, quit Dia normally via its menu or AppleScript. If Dia declines scripted quit, ask the user to quit normally; do not force-kill it. A live write requires Dia closed and rejects stale rules or changed destination mappings.

```sh
dia-tools link-rules apply plans/link-rules.json --write-live
open -a Dia
dia-tools link-rules verify plans/link-rules.json
```

Save the returned plan/receipt and encrypted backup path locally. The CLI preflights a copy, backs up the live store, and applies targeted SQL inside a transaction. A stale plan must be regenerated and reviewed against current data; never bypass the comparison or restore an older store to make it pass.

After restart, open Settings → Advanced → Incoming Links → Manage Rules. Inspect current Accessibility labels and compare **every** host, scope, and destination against the approved plan, including rows requiring scrolling. Wait for startup with bounded retries. Record UI verification separately if automation access is unavailable. A persisted row or visible rule does not prove external link delivery; test representative external links only when opening those URLs is appropriate to the user's request, and report which behavior was actually tested.

Do not change the separate “New windows open with” setting as a supposed routing fallback. Report final rule counts by space, changes, persistence/UI results, untested delivery behavior, and backup location. Keep plans, receipts, domains, IDs, and screenshots outside source control.

## Undo a scoped change

Read the original plan's `before`, `after`, and `changes`. For each originally touched key, restore its original row or remove it if originally absent. Compare its current state with the expected post-edit state first; flag intervening edits instead of overwriting them. Build a new changes file and fresh plan, then use the same copy test, shutdown, backup, and verification steps. Do not restore the whole database over newer rules or browsing state.

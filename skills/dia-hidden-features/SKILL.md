---
name: dia-hidden-features
description: Discover, enable, disable, and verify hidden Dia browser settings and feature flags on macOS, including Incoming Links (Link Air Traffic Control). Use for feature availability and local overrides; use dia-link-rules for routing rule contents and dia-settings for ordinary stored preferences.
---

# Dia Hidden Features

Use `dia-tools` with the `feature-flags` command group, or `bun src/cli.ts` from a prepared dia-tools checkout. When this skill is linked into an agent's skill directory, resolve the link to find the source checkout two directories above the skill. A distributed skill requires a separately installed CLI. Check `feature-flags --help`; an older binary may need rebuilding.

## Establish the actual gate

Read the installed version with `dia-tools doctor`. Inspect current UI availability and `dia-tools feature-flags list`. The latter lists local overrides, not every supported flag or its effective remote value.

For Incoming Links, read [known-features.md](references/known-features.md). For an unknown feature, follow [investigation.md](references/investigation.md) before writing. Establish which consumer and storage mechanism actually control the requested behavior. A string in the binary is only a candidate. Do not claim this skill can enable every server-controlled feature.

## Plan and apply a scoped override

For the validated Incoming Links gate:

```sh
mkdir -p plans
dia-tools feature-flags plan external-link-destination-enabled true --out plans/incoming-links.json
dia-tools feature-flags apply plans/incoming-links.json
```

Use fresh output filenames for subsequent plans. Show the one requested flag's before/after state and expected UI change; the plan retains every other override. Setting `false` is an explicit false override. Use `plan FLAG --remove --out FILE` to return that flag to Dia's normal evaluation instead.

If the user asked only for discovery or a proposal, stop after presenting it. Otherwise existing authorization for this concrete change is sufficient; do not ask again just because it writes. Quit Dia normally using its menu or AppleScript. If Dia declines scripted quit, ask the user to quit it normally; do not force-kill it. `--write-live` refuses a running Dia process.

```sh
dia-tools feature-flags apply plans/incoming-links.json --write-live
open -a Dia
dia-tools feature-flags verify plans/incoming-links.json
```

Keep the returned backup path. The CLI checks the complete original override string before writing, creates a private JSON backup of this preference, merges only the requested flag, and reads it back. It does not back up the entire preferences domain. If stale, regenerate and review the plan against fresh state. `--user-data` does not redirect macOS feature preferences: these always target the current user's `company.thebrowser.dia` domain.

## Verify behavior and undo when needed

Allow startup to finish, then open the actual feature UI. For Incoming Links, verify Settings → Advanced → Incoming Links → Manage Rules. Inspect current Accessibility labels; do not hardcode row numbers or require the window title to be `Settings`. Use bounded retries if the menu is initially unavailable. If UI access is unavailable, report stored-state verification separately and leave UI verification pending.

Persistence alone is not evidence that a gate works. If the override does not reveal the feature, investigate the active consumer and remove the ineffective override before trying another candidate within the requested scope. Avoid accumulating speculative flags. Report the app version, flag, stored result, UI result, backup, and any untested behavior. Seeing Manage Rules does not prove external links route correctly.

For rollback, read the saved plan's `before` string to find this flag's original value. Generate a **fresh** plan that restores just that value, or removes the flag if it was absent. Apply through the same shutdown/backup/verification process. Preserve overrides added since the original edit; do not restore the entire old domain or string blindly.

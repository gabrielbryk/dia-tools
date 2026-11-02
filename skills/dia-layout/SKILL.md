---
name: dia-layout
description: Propose a Dia saved-tab, folder, and space layout using current saved contents and deduplicated Arc/Dia visit history. Use for cleanup, quick-access prioritization, or organizing a migrated library; produces a reviewable plan rather than rearranging live tabs.
---

## Collect current evidence

Run the prepared CLI from an installed package, or substitute `bun src/cli.ts` in a prepared source checkout:

```sh
dia-tools usage --out /absolute/path/to/fresh-local-report
```

The command produces `dia-usage.json` and the offline `dia-usage.html`. It reads Dia's saved tree and includes local Arc history when available. Use `--no-arc` for Dia-only evidence, `--arc-user-data PATH` for another Arc data root, and `--timezone IANA_NAME` for the user's calendar-day timezone. Dia's data root is the global option `dia-tools --user-data PATH usage ...`. `--open` opens the report locally.

Check each profile’s `arcMapping`, `sourceCoverage`, `issues`, and `excluded` fields before interpreting results. Inspect `unmatchedArcProfiles` as well: a report marked `complete` can still have unmatched Arc profiles, so the overall status alone does not establish complete cross-browser coverage. Arc and Dia profile directory numbers are not interchangeable. Unique display names are an initial mapping, not proof that account context stayed the same. If needed, supply `--arc-profile-map FILE`, a JSON object mapping Dia profile directory names to Arc directory names. Preserve ambiguous or unmatched profiles as unresolved; do not pool their histories. Read [methodology.md](references/methodology.md) when assessing coverage, overlap, URL matching, or rankings.

Keep reports outside the source repository. They contain private saved URLs and usage evidence even after credential redaction. Missing history or partial extraction is a coverage limitation, not evidence of inactivity. A failed live read should be reported; do not silently substitute an older inventory as current.

## Preserve the saved-only scope

For each non-deleted tab or folder, walk toward its ancestors to the nearest known container: `pinned_container` or `favorites` means saved; `window` means ordinary open content and is excluded, including named window groups. A saved container can itself sit structurally beneath a window, so a more distant window ancestor does not override that saved classification. Check the full ancestor chain for deletion or damage. A folder title does not establish that it is saved. Count tabs once, not once per split-pane URL. Keep folder tabs, standalone saved pins, and Favorites separately visible; a saved page can be open and still belong in this inventory.

Reconcile the saved totals and check for unknown containers, missing parents, and failed stores. Retain dynamic saved folders, including empty ones, and preserve split-pane membership. Do not turn ordinary open tabs, temporary window groups, or absent URLs into cleanup targets unless the user explicitly expands the scope.

## Design the layout

Use folder contents and actual working contexts alongside usage evidence:

- Keep profiles as account/session boundaries. Use spaces for distinct contexts within a profile; propose a new space only when it separates a recurring workflow, not merely a topic with a few bookmarks.
- Give frequent destinations convenient placement, checking whether they already appear in Favorites or saved pins. Do not create duplicate shortcuts merely because the same URL ranks in multiple spaces.
- Group live dashboards and operational entry points separately from reference material and software comparisons. Prefer a shallow tree with recognizable names; retain project names when their meaning is unclear.
- Treat low-frequency references as a library. Do not infer that a school, job, project, or saved app is inactive solely from old or absent history. Mark uncertain archive decisions for review.
- Keep origin-wide activity as context. It cannot establish usage of an individual repository, app route, or saved tab. Cached error titles need verification before calling a link broken or promoting it.

When the user authorizes subagents, useful independent tasks are history/source validation, library/layout analysis, and review of the proposed mapping. Give each the same snapshot and saved-only boundary, then reconcile disagreements. Delegation is optional and does not authorize additional browser changes.

## Deliver a concrete proposal

Provide a local readable report with:

- Snapshot time, source coverage, profile mappings, exact versus probable rounded-import overlap, and saved-only counts. Keep exact-only totals and overlap uncertainty visible when inferred matches affect the evidence.
- A per-profile proposed space/folder tree and a short quick-access list with usage evidence and existing placement.
- Every in-scope source folder ID mapped once to its proposed destination, keep decision, or explicit review item. Splits must name the intended destinations; unresolved individual saved-tab moves remain unresolved rather than implied.
- Changes from the existing layout, confidence, and the few decisions that require personal context. Preserve favorites, tab order, split panes, dynamic-folder behavior, and account boundaries in any later move plan.

Separate evidence from interpretation: the usage command generates evidence and a usage viewer; the agent develops the layout. Check report counts, search/filter behavior if interactive, and that private artifacts were not added to Git.

This workflow does not apply a layout. If the user later asks to apply it, re-read the live state, prepare exact ID-based changes and a backup, and use a validated write implementation within their authorization. Stop on stale IDs or changed source contents rather than applying an outdated plan. Do not claim that the usage CLI supports folder moves.

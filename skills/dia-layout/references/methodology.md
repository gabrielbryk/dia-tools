# Interpreting Arc and Dia usage evidence

## Source identity and coverage

Dia's saved inventory comes from each profile's `tabs.db`. Navigation history is Chromium's extensionless `History` SQLite database; it is separate from that saved tree. Arc has its own profile roots and display-name metadata. Include history only from the mapped profile, and record missing, ambiguous, unmatched, and failed sources. An unmatched Arc profile can be reported as additional available history without assigning it to a Dia account.

History sources may be large. Prefer the CLI’s read-only consistent transactions for `History`; a diagnosed SQLite busy/locked condition can use its bounded, consistency-checked snapshot fallback for smaller databases. Do not blindly copy multi-gigabyte history files or bypass the fallback’s size limit. Encrypted Dia stores use the project’s validated snapshot/key derivation helpers. Source snapshots need not share one instant: report their collection times and any intervening changes that matter.

The earliest and latest retained visit dates describe available records, not continuous coverage. Cleared history, sync, migration, and browser retention can limit observations. Distinguish a valid source with zero matching events from an unreadable source. Do not treat the latter as zero use.

## Matching and overlap

Use exact saved URLs for tab-level evidence. Sanitized credential URLs and non-HTTP(S) pages may be unmatchable. Do not strip query strings, paths, fragments, or account identifiers to increase apparent matches: those can distinguish different destinations. If a landing URL has few exact visits but its origin is active, flag it for inspection rather than crediting every origin visit to the saved tab.

Arc-to-Dia migration can duplicate visit records. First match overlap by the exact URL and original Chromium microsecond visit timestamp. Database row IDs are local to each database and are not cross-browser identifiers. Preserve repeated events within a source.

Some imported records retain only whole-second precision. After exact matching, the CLI may infer probable rounded-import overlap only for the same raw URL and second, with a unique residual timestamp on each side and exactly one whole-second timestamp paired with one fractional timestamp. Do not broaden this into general same-second/day bucketing: distinct fractional visits close together must remain distinct. Present probable matches separately from exact overlap, retain exact-only totals as a comparison, and surface ambiguous cases. A ranking affected by probable matches carries that uncertainty.

Aggregate over the diagnosed cross-source union rather than adding Arc and Dia counters. Report overlap and source-only contributions so apparent activity increases are explainable. The report’s per-profile `overlap` counts cover the full 90-day input histories, not only visits that match saved URLs; label that cohort and window when presenting them.

A visit is URL-level evidence. Identical saved URLs in different folders or spaces share that evidence; history does not identify which saved entry was clicked. A split tab may have multiple URLs, so union its matching visit records before counting. Origin-level context can be shown separately but should not silently drive exact-tab rankings.

## Ranking and interpretation

Prefer distinct visited dates over raw visit volume when identifying regular use. Reloads, redirects, background navigations, and sync can inflate counts. State the rolling window, timezone, and tie-breakers. A rolling 30-day interval can intersect 31 local calendar dates; this is different from a fixed calendar-month report.

Keep recent frequency and longer-term context visible, such as 30-day and 90-day metrics. A recent project can justify accessible placement without displacing durable references. Report each profile independently so a high-volume work app does not obscure a useful personal shortcut.

Navigation history is not a focus log. It does not capture every return to a loaded tab or establish active reading time. A stored `last_active_date` is supporting recency evidence, not a frequency count. Avoid inferring time spent from visit duration without separately validating that field's semantics.

Low or absent exact matches are insufficient grounds to delete, archive, or label a saved item unused. Consider route changes, login redirects, older activity, missing sources, and the intended role of reference material. Recommend placements with confidence and keep ambiguous cases for review.

## Review artifacts

Use stable source IDs for proposed moves, with current profile, space, parent, and title as review context. IDs are scoped to their browser/profile; identical IDs elsewhere are not necessarily the same object. Preserve the original entry when suggesting an alternative destination until a later apply step is authorized and validated.

When summarizing “top tabs,” collapse repeated URLs in the narrative or identify their duplicate placements. Avoid summing the same usage evidence twice. Show already-accessible entries separately from candidates for promotion. An error page or login callback with many visits may indicate friction rather than a desirable shortcut.

# Recover Arc routing rules for a Dia proposal

Only inspect Arc when the user requests recovery or migration. The observed source is `~/Library/Application Support/Arc/StorableLinkRouting.json`. Read a local copy and preserve original rule order, identifiers, and match strings in a private export. Do not edit Arc's file.

The examined document had a version-1 representation with nested enum objects. Inspect its actual shape before extracting. A URL-contains source component used `sourceComponents[].componentType.urlMatch._0.contains._1`. Destinations carried nested space identifiers. Resolve those IDs against current Arc sidebar space data; older sync artifacts can carry stale names. Treat missing mappings as unresolved.

Do not mechanically copy a substring into Dia's hostname field. Arc rules may contain paths, organization names, broad text fragments, or markers that are not domains. Dia's observed table supports exact hosts or host-and-subdomain matching, so some Arc rules cannot be represented faithfully. Show those exceptions to the user and propose explicit hosts only when grounded in the original rule or relevant browsing context.

Map Arc destinations to current **Dia space IDs** from `link-rules list`; names alone are not IDs and profile boundaries can differ. Present the fresh Dia proposal split by space, including overlaps and any behavior lost in conversion. Arc's `mostRecent` default is not evidence for a configurable Dia fallback record. Do not alter Dia's window-opening preference to simulate it.

Keep all real exports and mappings in ignored local artifact directories. Include only synthetic examples in the skill or repository.

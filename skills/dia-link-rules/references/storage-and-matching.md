# Store and rule semantics

Observed on Dia **1.55.1 (89833)**. Verify the installed schema before edits; the CLI refuses an unsupported layout.

- Physical file: `~/Library/Application Support/Dia/User Data/external_link_rules.db`.
- CLI logical profile/family: `Global` / `external_link_rules`.
- Key derivation context: `global/external_link_rules`.
- Encryption: SQLCipher, accessed through dia-tools using normal macOS `Dia Safe Storage` Keychain authorization. Never print or persist derived keys.

```sql
CREATE TABLE external_link_destination_rules (
  host TEXT NOT NULL,
  match_scope TEXT NOT NULL,
  space_id TEXT NOT NULL,
  PRIMARY KEY (host, match_scope)
);
```

| Stored scope          | Native UI meaning            |
| --------------------- | ---------------------------- |
| `exact_host`          | This host, across paths      |
| `host_and_subdomains` | This host and its subdomains |

Use lowercase canonical hostnames without schemes, ports, paths, wildcard prefixes, or trailing dots. The helper supports IPv4 only with exact matching; IPv6 literals are currently unsupported. Do not silently convert arbitrary URL substring rules into host rules. There is no path, query, organization slug, explicit priority, or fallback column in this observed table.

For example, `example.com` with `host_and_subdomains` includes `api.example.com`. Routing that subtree to one space and `api.example.com` to another is ambiguous without verified precedence. The helper conservatively rejects cross-space overlaps; overlapping rules pointing to the same destination are accepted.

Destination IDs come from each profile's `tabs.db`, table `spaces(id,title)`. They are space IDs, not profile directory names. A space rename or profile move after planning requires replanning. The CLI also binds plans to the selected User Data root and compares the entire current rule set before applying, so unrelated concurrent rule edits also invalidate a plan.

“Last Used Profile” appears as a native option that removes a link rule in the examined implementation. It is not a separate fallback record to insert. “New windows open with” is a separate setting and must not be changed as part of rule editing unless explicitly requested and independently investigated.

Reads snapshot the database and committed WAL state. Live writes require normal app shutdown and create an encrypted backup with its derivation-context manifest. For inspection, use `dia-tools link-rules list` and `dia-tools sql-schema --profile Global --family external_link_rules`; use the dedicated planner for mutations.

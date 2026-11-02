# Validated local override

Observed on macOS with Dia **1.55.1 (89833)**. Recheck after upgrades; these are reverse-engineered implementation details, not a supported API.

| Item               | Observed value                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| Feature            | Incoming Links / Link Air Traffic Control                                                                     |
| Working flag       | `external-link-destination-enabled`                                                                           |
| Enabling value     | string `true`                                                                                                 |
| Preferences domain | `company.thebrowser.dia`                                                                                      |
| Preferences key    | `transientFeatureFlagOverrides`                                                                               |
| Serialization      | `flag-one=true\|flag-two=false` as one string; the backslash here is Markdown escaping, not part of the value |
| Visible result     | Settings → Advanced → Incoming Links → Manage Rules                                                           |
| Rule store         | `User Data/external_link_rules.db`, logical profile `Global`                                                  |

The flag is consumed by the external-link destination service. Enabling it through the macOS preference survived restart and exposed the native rules editor. Rule contents are a separate operation covered by `dia-link-rules`.

The binary also contained `link-routing-enabled`, but experiments with that name did not reveal this UI. Its presence was insufficient evidence that it controlled the active service. Do not use it as an alias for the working gate.

A parser for `StorableFeatureFlags.json` also existed, but that did not establish that the active feature client loaded the file. Editing a guessed JSON file or a remote flag cache was not the successful path. Multiple feature clients and old implementations can coexist in one binary.

Native rules editing and encrypted readback were verified in this build. End-to-end delivery from an external application and cross-device synchronization require separate tests. Do not infer either from a successful preference write.

# Independent original calibration-parent transport

`native-calibration-parent-archive.v1` is an offline preparation contract under
D134. It wraps a separately trusted complete or superseded five-table native
core and original calibration batches, their entire cell sets, and successful
original calibration producer/dependency job receipts. It does not activate a
production reader, migration, upload, archive destination, eviction or reclaim.
The subsequent D135 adapter reuses this declared-parent integrity under a separate
default-OFF historical reader gate; adding the code does not activate it or change
current/action authority. See [the reader contract](native-historical-archive-reader.md).

The parent manifest binds the trusted core digest, schema, generation, capture
clock and explicit dirty-source flag. Each object preserves exact PostgreSQL
`to_jsonb(row)::text`, IDs and hashes. Readers require an external trusted manifest
and schema digest. Downloaded self-reports are not trust anchors. Missing,
corrupt, extra, foreign-tenant/account/day/epoch parents, incomplete batches,
incorrect cell cardinality or cell-set hash, missing successful original jobs
and ambiguous original computation clocks refuse. No historical thresholds or
canonical decision identities are recalculated.

Each retained context binds its provider account, calibration as-of day and
original computation instant to exactly one complete batch. Snapshot calibration
IDs additionally bind the precise selected cell when original serving snapshots
still exist. Superseded archives have no original mutable serving cells and do
not fabricate them. Their declared calibration coverage is the complete original
batch at the context's computation instant; it is not a claim that the context
stored an original selected-cell primary key. An ambiguous or unavailable batch
must refuse. Explicit no-cell soft-only contexts can retain zero parents; a
missing ready calibration cannot become a synthetic default. A soft-only context
may retain a known batch while its snapshot correctly has no hard calibration
authority.

Completed native calibration batches/cells are append-only under actual
production triggers. Unlike mutable serving snapshots, they can be transported
as original evidence. A later successful idempotent calibration attempt can
have a different run ID from the original batch producer. Both receipts are
retained when needed, never relabeled as each other. Cell-set hashes use the
stored readable calibration contract stamp. This verifies transport membership
and declared lineage, not every producer formula, source receipt or upstream
raw fact in a full disaster-recovery closure.

UTC timestamp comparison retains all PostgreSQL microseconds and accepts only
UTC serialized clocks, including the existing pin census's original PostgreSQL
`transaction_timestamp()::text` spelling. It does not rewrite JSONB/census bytes or normalize
canonical identity/freshness. External identity roots are business and physical
provider-account IDs plus their binding, provisioned separately in the target.
Users, provider-authentication/credential tables and credential fields are not
parent objects. Root provisioning still needs a separately approved production
identity/access policy; fixture identity stubs are not that policy.

The real PostgreSQL guard is integrated into the owned random-loopback native
seam. A source database and TWO independent restore databases each run actual
`run-migrations` production DDL. Only transported core/calibration evidence is
loaded; unrelated source parent tables and source user credentials are never
copied. Fresh target owner IDs prove independently provisioned identity roots.
The served and superseded transports preserve all seven distinct evidence
tables, original and replay ledgers, microsecond clocks and large JSONB decimals.
To respect production cell immutability, a NEW target batch is initially writing,
receives its transported cells, then takes the allowed exact completion
transition in the isolated transaction. PostgreSQL JSONB operations set only
these lifecycle fields; Javascript never reserializes numeric evidence. Final
rows must match the original complete bytes. Actual immutable-cell/batch guards
and served snapshot calibration FK remain active. These are schema fixtures;
the existing separate 501-evaluation actual producer proof remains separate.

This closes local declared calibration-parent transport/independent restore
preparation. It does not close every transitive parent or non-FK consumer,
production historical-reader compatibility, durable-target access/cost/horizon,
live census, unique reclaimable bytes, eviction or physical reclamation. Every
historical view still has providerAuthority=false and reclaimEligible=false.
The finite 163 GiB admission step and live acceptance do not grant storage,
resource, deletion, disk-maintenance or further budget authority.

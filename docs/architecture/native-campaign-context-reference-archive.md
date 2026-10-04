# Shared campaign context in native historical archives

D143 extends historical storage compatibility for the D142 new-row reference
writer. It changes no decision formulas, engine epochs, input/context/decision
hashes, calibration clocks, freshness buckets or provider execution authority.

The original five-table core and seven-unique-table calibration-parent formats
remain unchanged and continue to refuse non-null campaign references. New
explicit `native-generation-reference-core-archive.v1` and
`native-superseded-generation-reference-core-archive.v1` formats carry the five
original tables plus `engine_v3_ad_campaign_context_objects`. Their
`native-calibration-reference-parent-archive.v1` parent transport has eight
unique tables, because the native and calibration receipts share one table.
Known pins may remain in a historical copy; they still veto removal. The
superseded format still requires zero serving snapshots and a supported census.

Selected objects must exactly match the evaluation's business UUID and BYTEA
SHA256. The copied original PostgreSQL `payload_json` text, encoding and UTF8
length must agree. Missing, duplicate, foreign, unsupported, contradictory or
unreferenced objects refuse; no live lookup or inline rewrite repairs them.
JSON syntax is validated, but an original top-level member slicer establishes
the hash without JavaScript numeric reserialization. Evaluation rows retain
their original inline-NULL/reference representation; object rows retain their
original JSONB bytes and creation clocks.

Encrypted envelopes/catalogs use their existing versions and limits. Historical
API evidence carrying a shared object explicitly uses
`decision-engine-v3-native-ad-historical-evidence.v2`, adding the original
`campaignContextObject` string. Inline historical responses retain the v1
contract and original four row fields. The UI displays the original shared row
under the same historical, review-only authority. Every reader still returns
provider authority, current-decision eligibility and reclaim eligibility false.

The historical HTTP response limit remains 256 KiB, independently of the 1 MiB
shared-object DDL limit and archive transport limits. A valid stored object whose
historical response exceeds 256 KiB is refused by `NativeHistoricalObjectBound`.
The reader returns `unavailable` (HTTP 409, `native_historical_archive_unavailable`)
and the UI shows unavailable or failed integrity validation. This is not the
retryable `limited`/HTTP 429 result. The reader does not raise the response bound
or truncate original evidence. A whole-table allocation measurement does not
establish each original object's raw payload length or a generation's archive size.

The owned real-schema test runs the actual producer for 501 public inputs and
four shared objects. Each source/current/superseded restore uses a separate NEW
database and actual migrations, original complete two-cell calibration parents,
independently provisioned credential-free identity roots, exact eight-table
JSONB/ID/hash/clock parity and the real SQL accessor. Object deletion refuses
23514, an unknown object FK refuses 23503 and immutable calibration mutation
refuses P0001. Dirty workspace metadata is retained. Synthetic successor state
and serializer/worker fixtures are not natural generations or all-parent DR.
All three new fixture databases explicitly use UTF8/template0 and verify their
server encoding. Turkish plus astral-emoji input passes the actual producer,
original PostgreSQL text/digest/byte-length checks and both full-byte restores.
The public worker fixture also carries these multibyte bytes without numeric
reserialization. This is local synthetic proof, not natural-generation proof.

One observed public current package was 4,649,170 decoded bytes / 368,863 stored
bytes; superseded was 3,676,947 / 229,612. The existing decoded 8 MiB and stored
2 MiB limits are unchanged. This is not a capacity forecast or proof that every
natural generation fits. A larger package must refuse; a bounded multi-object
transport would require a separate contract instead of increasing these limits.

No production export, catalog activation, row removal, object GC, reverse index,
reader switch or physical reclaim follows from this source preparation. Shared
objects may still have other live references and the current immutable DELETE
guard remains enforced. A selected evaluation copy is not a complete incoming,
non-FK or transitive-reader inventory. Sustainable item3 and strict natural
positive-reuse item7 remain open.

For a later release, require actual source review, canonical QA/build, exact-SHA
CI/images and fresh admitted capacity. Keep the existing catalog until the new
reader is live; older readers intentionally refuse the new reference contract.
Activate only exact independently trusted objects after actual authenticated
HTTP/body and current-schema restore parity. Retain both recoverable copies,
the prior catalog and live roots until acceptance. An older reader/code rollback
requires restoring its compatible catalog before reader recreation; do not
reverse the nullable reference schema or rewrite original generations. New
worker/web starts require their own process observation. Physical reuse and
strict positive native reuse need separate natural evidence.

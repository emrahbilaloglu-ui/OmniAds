# Explicit encrypted historical native evidence reader (D135)

Status: SOURCE preparation; runtime gate is OFF by default. No production archive,
resource, key, upload, catalog publication, reader activation or reclamation has
been performed. This is a real adapter and API/component path, not a current
serving replacement or sustainable-capacity acceptance.

## Identity and authority

The existing exact-Ad evidence route retains its current behavior by default.
An explicit `view=historical` additionally requires original `archiveJobRunId`,
`evaluationId`, `asOf`, and `engineVersion`. Business membership is checked before
archive access; account/Ad/evaluation/job/day/epoch must match the separately
trusted original package exactly. There is no newest-object search and no current
fallback. Malformed or incomplete history selection refuses.

The result has a separate `historical_available` contract, historical_read_only,
providerAuthority=false, currentDecisionEligible=false, and reclaimEligible=false.
Its raw evaluation/context/input/snapshot rows remain exact PostgreSQL JSONB text,
including microseconds and decimals exceeding Javascript precision. A superseded
archive contains no invented daily snapshot. Original authorized verdict fields
inside row text are historical evidence only. The evidence component accepts an
explicit history selection, keys its cache by original identity, rejects a current
response for that selection, and renders a review-only banner and raw evidence.
No automatic archived-generation browser/list or discovery UI is implemented.

## Independent trust and encryption

`native-historical-archive-catalog.v1` is read from a configured absolute local
file with no final symlink or group/other write access. Its raw-byte SHA256 comes
from separate deployment configuration, not from downloaded data. The catalog is
bounded to1MiB/128 original-generation entries. Publishing a new catalog/digest is
an operational gate, not a user query or this implementation's side effect.

An entry binds original business/job/day/epoch, parent manifest/schema digests,
encryption key ID, plaintext/ciphertext lengths and SHA256s, content-addressed key,
and exact non-null object VersionId. The separately trusted D134 parent manifest
also binds the complete/superseded D132/D133 core, original calibration batches,
cells and producer/replay receipts. Missing, corrupt, foreign, ambiguous or
unsupported parents/versions refuse. This is declared calibration closure, not
all upstream metrics/configuration readers or full DR.

Packages use client-side AES-256-GCM with a freshly generated12-byte nonce and
16-byte tag. Associated data binds generation, parent trust, key ID and plaintext
hash/length. The full downloaded ciphertext digest is checked before decrypting;
GCM and independent plaintext digest/length are checked before parsing. Exact
row strings are retained rather than parsing and reserializing numeric evidence.
Plaintext is bounded to64MiB; a bigger generation refuses rather than silently
chunking. No compressed expansion path is added. The seal helper is LOCAL only;
local dirty-source metadata can be encrypted/restored, but runtime historical
publication refuses a dirty source. Encryption does not manufacture a clean build.

The data key and catalog are independent recovery prerequisites. Losing either
can make the stored ciphertext unreadable; Object Lock is not key recovery. No
production key or escrow was generated. A real owner-held recovery rehearsal,
backup location, rotation/old-key retention and custody are still required.

## Actual runtime transport and default-off configuration

Only exact versioned `GetObject` is used, through pinned AWS SDK v3. There is no
List/Head/Put/Delete or provider/admin credential fallback. Runtime endpoint is
fixed to private FSN1 configuration, `https://fsn1.your-objectstorage.com`, with
explicit archive-only credentials, forcePathStyle and maxAttempts=1. Request and
stream share one5000ms deadline; declared/actual bytes and returned version must
match trust. Abort destroys the stream and client. This is a GET-bound timeout,
not an end-to-end CPU/pool/throughput or production SLA.

Required explicit env configuration:

- ENGINE_V3_NATIVE_ARCHIVE_HISTORICAL_READER_ENABLED=true (otherwise disabled)
- ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH and independently supplied CATALOG_SHA256
- ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID and ENCRYPTION_KEY_HEX (32 bytes)
- ENGINE_V3_NATIVE_ARCHIVE_S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY

All names above after the first also carry the `ENGINE_V3_NATIVE_ARCHIVE_` prefix.
Only the configured key ID is supported; retirement/rotation requires deliberately
prepared configuration, not a fetched secret. Credentials, paths and object errors
are not returned to the browser. Enabling these keys/configuration is a separate
reviewed live step after resource/access/retention/pilot gates, not implied by a
merge/build or the global engine-enabled flag.

Activation additionally requires measured request-cost safeguards. Before the gate
is opened, implement single-flight and a bounded verified-result cache keyed by
exact `(versionId, ciphertextSha256)`; enforce global and business concurrency
bounds; move decrypt/parse/full validation off the web event loop or establish a
smaller package cap from measured CPU/memory latency. Add sanitized operational
logs without keys, paths, row bytes or credentials, and decide the permitted role
and egress budget. These safeguards are NOT implemented in this source phase.
The current `guest` membership check and64MiB cap do not establish affordable
throughput; setting the env configuration alone is insufficient for activation.

Official contracts checked for this adapter:
[GetObject SDK examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html),
[Hetzner supported S3 actions](https://docs.hetzner.com/storage/object-storage/supported-actions/),
[Node AES-GCM authentication](https://nodejs.org/docs/latest-v22.x/api/crypto.html#class-decipheriv).
Hetzner conditional PUT on versioned buckets is not assumed; ETag is not a trusted
content hash. No actual Hetzner object read/write or policy test is claimed.
The SDK's default response checksum behavior must be verified against the actual
target during that pilot; loopback compatibility is not Hetzner compatibility.

## Guards and remaining production storage work

Meaningful guards cover exact current/superseded raw evidence, foreign scope,
missing/duplicate/trust/schema/cipher faults, wrong key/AAD/tag, dirty publication,
byte bounds, signed one-GET loopback transport, version/stream/timeout refusal,
route authorization, explicit history selection and authority-free presentation.
The existing owned actual-migrations parent seam additionally passes its complete
package through encryption/decryption and independent seven-table restore. Dirty
local metadata remains visible and cannot pass the runtime publication gate.
A synthetic HTTP fixture is not durable S3, least-privilege/Object-Lock acceptance
or actual provider scope; isolated PostgreSQL is not a live archive migration.

Current workspace, action/config/proposal/controlled registry, scheduler/reuse,
hysteresis and outcome readers remain on pinned live source rows. They do not
import the historical adapter. Their full semantic incoming/non-FK/transitive
closure is still required before a separately defined evaluation/context-only
removal unit. Original parent closure, current reader compatibility and historical
API availability do not themselves authorize any removal.

Remaining #3 work: actual private target/account/cost/access and negative policy
probes, independently recoverable keys/catalog, actual durable exact-version
readback/restore, all consumer/pin closure, measured generation population/horizon,
new-row growth control, and separately authorized physical reclamation with fresh
scratch/WAL/lock/restore gates. No reclaimable bytes, retention horizon or
sustainable-growth claim follows from this source phase. D129 clocks/epochs and
strict natural reuse requirements remain unchanged. Rollback this source phase by
reverting adapter/route/component/docs; the default-off gate, current DB data and
legacy current paths remain available throughout.

# Host operator: verify the running release (D176)

The accepted immutable runtime is `eb9d4af190632e078a8394514d25f203bcbb7647`,
with runtime inventory
`4fc2add5a34b2933878ff54386affde0bb70308b1338bf47cd833cdcf432189f`.
Its web, worker and archive role/OCI identities and all required CI checks passed.
Deployment intentionally leaves an old host Git checkout in place. The actual
host HEAD observed `6755e76b75a17b4d0036cc7bfe03a6aee5b82793`; it is not the
running image's source. The original host installer refused before creating
its control root, authorizing the mirror key, starting private PG or moving data.
Do not relabel/reset that checkout or call the refusal successful installation.

Use `scripts/ops/install-native-cold-runtime.py`, a separately reviewed host
operator. It imports the original pinned host helpers from the runtime's exact
`/opt/adsecute-native-cold/<runtime-inventory>` package. Its own bytes must match
the source review's additional `hostOperatorSha256`; stage it at
`/opt/adsecute-native-cold-runtime-install/<operator-sha>/install.py`.
The frozen runtime inventory and application image remain unchanged. The old
installer stays part of that immutable historical package and is not consumed.

Before any mutation, the new operator checks all three actual immutable image,
OCI and process identities, provider-worker absence of archive mounts, read-only
web / writable archive scopes and actual held-key hash. It hashes the host
Compose against the reviewed Compose and invokes the reviewed 146-file verifier
INSIDE the actual immutable archive image. A matching environment label or host
checkout can never substitute for image identity or actual source bytes. The
verification subprocess's inventory variable enables no lane or data mutation.

Preparation, private socket-only PG/volume checks, restricted mirror-key scope,
review/installation receipts, exact flag updates and compatible rollback reuse
the original closed operations. No new source DB/provider operation, budget,
clock, snapshot/retention rule, C3 kernel or decision authority is introduced.
Activation still requires actual mirror telemetry and all existing runtime
restore/copy/HTTP/pin/physical/commit/absence gates. An operator's successful
preflight is not real-original restore or archival completion.

Validation separates mocked Docker preflight regression (legacy host checkout,
image relabel, wrong role/stopped container, mount scope, key mismatch, actual
source drift and host Compose drift) from the next actual host invocation.
Record the operator SHA/review separately from the runtime build/inventory;
never claim new operator code was inside the earlier application's CI image.

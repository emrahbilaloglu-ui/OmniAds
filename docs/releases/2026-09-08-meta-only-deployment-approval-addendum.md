# Meta-only deployment approval addendum — 2026-09-08

## Decision

**Approved now:** create one final release-candidate commit and open one PR for
the Meta operator-readiness work.

**Deployment remains conditional:** deploy only the exact final `main` SHA after
every required CI check on that head is green, every blocking review finding is
resolved, both exact-SHA images exist, and the normal deploy workflow accepts it. There is no
candidate SHA yet; this document does not invent or reserve one before the
commit exists.

This is a Meta-only release decision. It is not a general serving-readiness,
multi-provider, database-recovery, or advertising-write approval.

## Current verified baseline

The current public release readback identifies the deployed baseline as:

`a2eb1b1b1dae9e69ffe470c39ada19731a570224`

At the same readback, web and worker were healthy and the deploy and release
gates passed. These facts describe the current live baseline. They do not prove
the uncommitted candidate, its CI result, its images, or its post-deploy state.

The local read-only PostgreSQL endpoint at `127.0.0.1:15432` was unavailable, so
no fresh local serving-freshness preflight is claimed here. Exact-head CI,
image publication, deploy preflight, and post-deploy readback therefore remain
mandatory; this addendum does not replace or weaken them.

## Historical D077 packet

`docs/audits/generated/d077-release-deploy-approval-packet-2026-08-30.json`
retains `decision: "NO_GO"` and its measured broad scope. It is dated evidence
for the six-business, multi-provider serving preflight, including non-Meta surfaces.
The unresolved rows are not claimed repaired or cleared.

For this Meta-only release, that historical broad verdict is retained as an
out-of-scope finding rather than relabelled as current Meta evidence. This
addendum supplies the explicit scope decision allowed by the packet: the old
packet continues to block a broad multi-provider GO, but does not by itself
block the separately bounded Meta release after the gates below pass.

## Authority remains closed

- Business automation stays CLOSED and effective fail-closed.
- No provider advertising write, provider-account mutation, database-recovery
  execution, cache fabrication, or production data repair is authorized by
  this document.
- Existing operator approval boundaries remain in force. Deployment does not
  constitute approval to execute an advertising action.

## Exact-head release gates

1. Freeze the intended tree as one release-candidate commit and record its full
   40-character SHA in the PR and generated release evidence.
2. Open one PR for that exact head. Resolve every valid blocking review finding
   on the PR. Any source change creates a new head and requires the affected
   checks and review to run again.
3. Require all repository-required CI checks on the exact final head to pass,
   including the canonical database seams. A prior green run or the current
   live baseline is not transferable evidence.
4. After merge, require `main` to equal the SHA supplied to the deploy workflow
   and require both web and worker images for that exact SHA to exist.
5. Use the repository-supported exact-SHA deployment workflow with its normal
   current-main-head, migration, release-gate, and post-deploy checks intact.
6. Accept the deployment only after public build identity, web/worker health,
   and the required post-deploy Meta readbacks all match the deployed SHA.

Stop before deployment if the reviewed head changes, a required CI or review
gate is not green, either exact-SHA image is missing, the deploy or release gate
no longer passes, business automation is not closed, or any post-deploy
identity/readback check fails.

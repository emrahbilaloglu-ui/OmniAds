# Accepted design-package residuals at vendor time

The vendored package's own audit says **NOT READY**. That is recorded here
verbatim and is never converted into a green application signal. Application
work proceeds against this contract with the defects below explicitly open.

`export/audit.json` — rule `3.1.0`, fingerprint `f27bf51b31dd…` — reports
**43 of 46 requirements PASS** and three failures:

| ID | Requirement | Reported value | Root cause |
|---|---|---|---|
| **REQ-27** | Reproducibility — the deterministic audit core must match the shipped hash-bound export | `MISMATCH vs shipped export`; live `f27bf51b31dd` vs shipped `982933856035` | The shipped export was generated at an earlier fingerprint than the current active files. |
| **REQ-28** | Every registered mutation must flip a genuinely-READY baseline to NOT READY | `22 of 23 true READY→NOT-READY transitions · STALE HASH`, failing `M11` | One mutation (`M11`) is undetected, and the stored report is bound to the stale fingerprint. |
| **REQ-41** | Export reconciliation must equal the current run at the same package hash | `MISMATCH vs shipped reconciliation` | Same staleness: `reconciliation.json` was generated at the earlier fingerprint. |

All three are **release-packaging staleness plus one real mutation gap** in the
design package. None of them changes a product design decision, and none of them
blocks application implementation.

## Rules this imposes on application code and tests

1. No application test, script, or report may state or imply that the design
   package is READY. `scripts/zero-base/verify-design-contract.ts` asserts
   `audit.verdict === "NOT READY"` and fails if that ever silently changes.
2. Audit results are never hand-edited. If the package is regenerated at one
   fingerprint, re-vendor it and update `SOURCE.md`; do not patch these files.
3. The archive SHA-256 and the active-manifest fingerprint are distinct values
   and must be labelled distinctly wherever either is quoted.

## Unlock condition

Re-vendor after the design owner ships an export regenerated at a single
fingerprint with `23/23` mutations detected, at which point REQ-27, REQ-28 and
REQ-41 should all report PASS and this file can record zero residuals.

## Design-decision divergences accepted at application level (2026-08-22)

These are **not** package defects and they do not change the audit verdict. They
are places where a later product decision diverges from a dated fact inside the
vendored package. They are recorded here rather than fixed by editing the
package, per rule 2 above and the master plan's §17.1.

| Package fact | Later decision | Authority | Resolution |
|---|---|---|---|
| `generated-contracts.ts:716` maps `/platforms/meta/audiences` with `mode: "merged"` onto `L-C-META-INTEL` | Dashboard v2 restores Audiences as the fifth Creative Studio tab, so the legacy path resolves to `/c/[businessId]/creative/audiences` | `docs/adr-004-meta-audiences-destination.md` (Accepted) | Overridden in `lib/zero-base/compatibility.ts` only. The package keeps its record. Closes at the next re-vendor. |
| `disabled:LAUNCH-06 launch` / `disabled:LAUNCH-07 add` describe execution as closed | Execution is **gated**, not permanently closed: `META_LAUNCHPAD_EXECUTION` defaults off, and the shipped state is `disabled-with-reason` | `docs/adr-003-launchpad-execution-posture.md` (Accepted) | The package's disabled semantics are honoured as the shipped default. The production body is closed to match the package, not the reverse. |

Precedence between the visual source file and this package is decided by
`docs/adr-005-visual-vs-vendored-authority.md`: the visual file governs
appearance, this package governs behaviour, and a control that is drawn but not
permitted resolves to `disabled-with-reason`.

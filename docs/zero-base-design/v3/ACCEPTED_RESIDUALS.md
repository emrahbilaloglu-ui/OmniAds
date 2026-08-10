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

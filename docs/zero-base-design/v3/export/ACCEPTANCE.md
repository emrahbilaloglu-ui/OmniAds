# Adsecute Zero-Base Design — V3 acceptance statement

This file is a human-readable receipt. It decides nothing: every verdict below is computed by
data/gates.js from one audit run (artifact 16) and one mutation run (artifact 20), both bound to
the active-manifest fingerprint in export/v3/audit.json. If this file and a computed result ever
disagree, the computed result is right.

- Registry: 46 requirements (data/requirements.js), all fail-closed; UNKNOWN counts as NOT READY.
- Completion: every registry row PASS; 0 FAIL; 0 UNKNOWN — no target count is hard-coded.
- Mutation suite: 23 registered mutations (data/requirements.js REQUIRED_MUTATIONS ↔
  data/mutations.js), each applied alone to a fresh clone of a genuinely READY baseline and each
  required to flip the verdict to NOT READY naming its exact requirement.
- Human reviews (SR-1…SR-6) are dated provenance with pointers only; REQ-42 checks their
  completeness, REQ-25 proves no review-based pass path exists.
- Scope: static design canvas. Measurements labelled prototype-tested are audit-measured
  geometry/contrast/anchors on the rendered artifacts; all behavior is
  specified-for-implementation with named implementation-stage gates (15 §7, data/semantics.js).
  No user testing was performed on this package. Nothing here claims production DOM,
  assistive-technology, provider, or user behavior.
- Archives: v1/ and export/v2/ are history, excluded from every scan, hash and gate.

To reproduce: open `16 Ledgers and Gates.dc.html` in a fresh browser with clean storage (offline
works — the runtime and fonts are vendored). The page recomputes everything and REQ-27 compares
the deterministic core against the shipped export/v3/audit.json at the same fingerprint. Then
open `20 Mutation and Retest Suite.dc.html` and re-open 16: REQ-28 accepts only a hash-bound
report of the full registered set with a READY baseline.

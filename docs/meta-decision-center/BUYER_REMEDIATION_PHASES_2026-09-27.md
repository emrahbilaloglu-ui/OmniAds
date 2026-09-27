# Meta buyer audit remediation

User authorization: implement the complete jointly reviewed audit plan in large
phases, with an actual Claude Code review at the end of each phase. Original
audit and evidence remain immutable outside the repository.

Base: d20da06595ae575a0c86f02e0ec0ce13e0ef8756 (origin/main and audited release).
Branch: codex/meta-buyer-remediation. Existing open PRs and the primary checkout
are preserved. No provider advertising changes are part of this implementation.

## Phases

1. **Operational reliability:** measured versus unavailable pipeline health;
   effective growth-fence headroom and repeat-write diagnosis; business-switch
   navigation reproduction and repair. Keep source invalidation conservative;
   do not suppress late attribution or erase retained evidence to save space.
2. **Decision and metric contract:** economic concern, authority, refusal and
   next step remain distinct; RTG blocker; Q037 Decisions/Studio semantics;
   reporting labels and equal-length comparison windows. Reporting dates never
   change decision identity or execution authority.
3. **Source and population coverage:** historical config gaps and ownership;
   lane access beyond the response cap; Studio scope reconciliation; frequency
   and metric observation semantics. Missing history stays unknown.
4. **Core correctness and policy validation:** same-window Refresh regression,
   unsupported break-even language, recent-sample and funnel/recovery/basket
   uncertainty, E1/F4 and latent geo/bid correctness. Version changed producer
   semantics; preserve old snapshots and proof validation. Unsupported policy
   challengers are rejected with evidence, not silently promoted.
5. **Operator learning loop and integrated acceptance:** distinguish operator
   acknowledgment/deferral from provider execution and outcomes; expose source
   and decision lineage; complete regression, build, DB seams and review.

## Review and release contract

Each phase produces a concrete diff, regression evidence, known limits and a
rollback statement. Submit those to the existing Claude Code conversation
`local_eafcfd38-ad99-4e87-b048-1df7ba1378e5` by clipboard. Capture the actual
verdict, resolve blockers, then continue. No new audit fan-outs. Phase review
is not a deploy or performance claim.

Final acceptance includes `verify:pre-push`, a production build, applicable
real-Postgres seams, account-isolated UI behavior and exact source evidence.
Do not replace historical provenance with current configuration, open provider
authority through manual advice, or lower calibration floors to create actions.
Live release/capacity changes require the final concrete scope, pre-state,
readback and rollback to be ready; no piecemeal release.

## Progress

- Phase 1: code reviewed APPROVE by Claude (r2, 2026-09-27).
  B1 distinguishes measured limit / completed telemetry refusal / reader failure;
  B2 names first calibration separately from account selection changes.
  Focused corrections: 112 tests; real native-ad PostgreSQL seam passed.
  Production-build local navigation: 40/40 passed. No live recovery claim.
  Review SHA256: 98b22563bb75b54112848348e87226a3bffd65111215e3f04f0a53685fde9ed6.
  Open release concerns: safe repeat-write reduction, fresh capacity evidence,
  actual production business-switch readback, integrated checks.
- Phase 2: code reviewed APPROVE by Claude (r3). Recorded refusals round-trip through real PostgreSQL; v19 missing reasons stay unknown. Focused 579, compatibility 151, held-copy 147 passed; served-field census 36 passed before final narrow copy correction. Typecheck and changed-file lint passed. Final full gate remains phase 5.
  Review SHA256: 4687e69d1cdcf31f42db5a0e70872608a4a14d5d2840c6576250e3fc35ab30dc.
- Phase 3: Claude r2 APPROVE. Full 530-row population is reachable; source-bound pages, fresh 409 recovery, recent-window metrics, rendered config-history coverage and daily Studio source coverage. Source reconciliation reproduces Q037 Studio $38.01/0 and separately records $86.49 withheld and $22.77 residual source difference. Real PostgreSQL seam passed; focused 479+118 tests, served census36, corrected DOM/route208 tests (one query-key pin corrected and19 re-passed); typecheck/lint passed. Review SHA256: a6db0c967d342d51c0fe5fa1f6d341bc52da12232d2d3023e75b259a18ede6c2.
- Phases 4–5: pending. Mobile detail parity, lane ergonomics, byte impact and final full gate remain in phase5.

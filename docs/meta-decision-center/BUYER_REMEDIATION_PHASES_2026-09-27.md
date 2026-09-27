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
- Phase4: Claude APPROVE code with mandatory phase5 R1–R3. Engine83files1883PASS, focused173PASS, realPG seamPASS, typecheck/lint passed. Prior epoch retained; nine bounded cases have three primary label changes plus removal of false held Refresh. Review SHA256: eef5576616760333db435f267e9732fdd3c840e476aee37a8e834c4d29f8f44f.
- Phase5: Claude r2 APPROVE (code). Its r1 caught a real render omission: the
  economic concern existed on the server but did not reach the card. The typed
  field now reaches action, blocked, watching and inspector copy, with exact
  reporting dates and economic concern before confidence/readiness. Production
  F4/profitability conflict cases passed real rendered-HTML assertions. The
  served-field census passed all36 checks. Native response and prior-epoch
  PostgreSQL seams passed. Integrated final QA remains the release gate.
  Review SHA256: bc9c8afc289074ac6925780575e93a4033b2cbf019ad8e903e98a8415c0074ae.

## Phase 5 candidate and release limits

- R1: prior-epoch review continuity with proof validation and unconditional
  authority stripping; next-eligible-day hysteresis is documented, no ETA promise.
- R2: frozen 13-account census, 10,448 paired core rows and 5,790 unchanged soft-only
  rows. Separate active-status and currency-specific historical spend exposure;
  nine label/held-label changes. Not a new production generation.
- R3: observed below-configured-break-even concern survives low confidence; an
  explicit loss reduction wins entity deduplication over generic recovery copy.
- Native feedback: selected business/account/Ad + snapshot/evaluation binding,
  actor/time/reason journal, optimistic concurrency; manual application claims,
  provider receipts and observational outcomes remain separate. Unknown schema
  cannot render as no prior response. Both responsive details expose this panel.
- Mobile queue shows the same purchases/CPA/recent-window details as desktop.
  Population paging keeps each non-empty lane represented and all eligible Ads
  reachable; no unmeasured flight state is invented to collapse rows.
- Capacity at 2026-09-27 08:50:09 UTC: 167,692,680,215 database bytes; about 3.82 GiB
  against the 160 GiB aggregate budget. Database-identity-matched telemetry from
  08:41:24 UTC measured 64,585,052,160 physical bytes free (60.15 GiB), above the
  40 GiB floor. Claude's fresh read of the deployed web/worker environment found
  no aggregate/table overrides and an expired temporary override. These are
  separate evidence sources; the SQL measurement alone does not prove env state.
  Same-day job count is not a duplicate-content proof: current reuse receipts
  returned reusable for 10 accounts and source_publication_changed for three.
  Existing semantic-source/rebind/target invalidation and real-PG controls remain;
  no late-attribution input is suppressed to impose a two-run daily cap.
- Byte impact: the frozen population's four JSON payloads total168,345,222 UTF-8
  bytes. An illustrative28-day economicDays field adds2,090 bytes per copy;
  this is payload sizing, not a PostgreSQL/TOAST/index/WAL forecast or evidence
  of reduced writes. The first new epoch writes fresh evaluation sets. No safe
  retention deletion or duplicate-content reduction is claimed without proof.

Local implementation does not claim live recovery or reduced production storage
writes. Release requires current effective table/aggregate fences, physical headroom,
exact-SHA deploy/readback and safe rollback. No production retention deletion or
budget-fence increase is authorized by this candidate.

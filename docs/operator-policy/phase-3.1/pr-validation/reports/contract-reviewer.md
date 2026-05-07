# Phase 3.1 Contract Review

Scope: `src/types/operator-decision.ts`, `lib/operator-decision-provenance.ts`, `lib/meta/decision-os.ts`, `lib/meta/decision-os-source.ts`, `lib/creative-decision-os.ts`, `lib/creative-decision-os-source.ts`, `app/api/meta/decision-os/route.ts`, `app/api/creatives/decision-os/route.ts`, `app/(dashboard)/platforms/meta/page.tsx`, `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx`.

## Findings

No contract violations found.

Verified points:

- `analyticsStartDate` / `analyticsEndDate` are modeled as analysis-only context, while `reportingRange` is explicitly tagged `reporting_context` in the provenance contract. See [src/types/operator-decision.ts](</Users/harmelek/Adsecute/src/types/operator-decision.ts:10>) and [lib/operator-decision-provenance.ts](</Users/harmelek/Adsecute/lib/operator-decision-provenance.ts:46>).
- `decisionAsOf` is the anchor for the operator decision windows and baseline memory, not the selected reporting range. See [lib/operator-decision-provenance.ts](</Users/harmelek/Adsecute/lib/operator-decision-provenance.ts:46>) and [lib/meta/decision-os.ts](</Users/harmelek/Adsecute/lib/meta/decision-os.ts:3311>), [lib/creative-decision-os.ts](</Users/harmelek/Adsecute/lib/creative-decision-os.ts:2625>).
- `actionFingerprint` and `evidenceHash` are built from business id, `decisionAsOf`, source window, source row scope, source decision id, recommended action, and evidence. The UI-selected reporting range is not part of the hash input. See [lib/operator-decision-provenance.ts](</Users/harmelek/Adsecute/lib/operator-decision-provenance.ts:60>).
- Action-bearing Meta rows carry provenance, evidence hash, and action fingerprint on campaign, ad set, and geo decision records. See [lib/meta/decision-os.ts](</Users/harmelek/Adsecute/lib/meta/decision-os.ts:1509>), [lib/meta/decision-os.ts](</Users/harmelek/Adsecute/lib/meta/decision-os.ts:2196>), and [lib/meta/decision-os.ts](</Users/harmelek/Adsecute/lib/meta/decision-os.ts:2414>).
- Action-bearing Creative rows carry provenance, evidence hash, and action fingerprint on each creative decision record. See [lib/creative-decision-os.ts](</Users/harmelek/Adsecute/lib/creative-decision-os.ts:2897>) and [lib/creative-decision-os.ts](</Users/harmelek/Adsecute/lib/creative-decision-os.ts:3013>).
- Missing provenance blocks queue/apply/push eligibility. The helper returns `blocked_from_push` when provenance is absent, and the command-center execution path turns that into a manual-only preview; apply and rollback paths also hard-fail when permissions are not present. See [lib/operator-decision-provenance.ts](</Users/harmelek/Adsecute/lib/operator-decision-provenance.ts:104>), [lib/command-center.ts](</Users/harmelek/Adsecute/lib/command-center.ts:1033>), [lib/command-center-execution-service.ts](</Users/harmelek/Adsecute/lib/command-center-execution-service.ts:958>), [lib/command-center-execution-service.ts](</Users/harmelek/Adsecute/lib/command-center-execution-service.ts:1846>), and [lib/command-center-execution-service.ts](</Users/harmelek/Adsecute/lib/command-center-execution-service.ts:2176>).
- Backward compatibility with `startDate` / `endDate` callers is preserved. Both routes still accept the legacy pair, default analytics dates from them, and only layer explicit analytics params when provided. See [app/api/meta/decision-os/route.ts](</Users/harmelek/Adsecute/app/api/meta/decision-os/route.ts:50>) and [app/api/creatives/decision-os/route.ts](</Users/harmelek/Adsecute/app/api/creatives/decision-os/route.ts:46>).
- No full media-buyer policy engine was introduced. The implementation remains a deterministic Decision OS with trust, policy ladders, queue eligibility, and bounded execution gates, not a general-purpose purchasing agent. See [lib/meta/decision-os.ts](</Users/harmelek/Adsecute/lib/meta/decision-os.ts:3311>) and [lib/creative-decision-os.ts](</Users/harmelek/Adsecute/lib/creative-decision-os.ts:2625>).

Route and UI call sites also stay aligned with that split: the dashboard pages request the Decision OS with the selected reporting range only, and the routes decide how to map that into analytics context and decision authority. See [app/(dashboard)/platforms/meta/page.tsx](</Users/harmelek/Adsecute/app/(dashboard)/platforms/meta/page.tsx:129>) and [app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx](</Users/harmelek/Adsecute/app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx:307>).

## Conclusion

The Phase 3.1 contract holds as written. Reporting range remains reporting-only, `decisionAsOf` is the authority anchor, fingerprints stay stable across UI date changes, provenance is attached to action-bearing Meta and Creative rows, and missing provenance still blocks execution paths. No policy-engine overreach was introduced.

Validation run: `vitest run` on the four targeted tests passed, 21 tests total.

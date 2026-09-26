# D123 selected-Ad acceptance evidence

Status: local candidate. Deployment and persisted generation require a separate
readback. No provider or production database writes were used for this audit.

Claude captured one TheSwaf account in a READ ONLY, REPEATABLE READ snapshot at
`2026-09-26T07:06:23.027Z`. All 920 inputs were hydrated to preserve the
account-relative frequency threshold; only the two named active Cut candidates
were recomputed. Original input/profile/source receipts and outputs remain in
`theswaf-manual-cut-advisory-capture-20260926.json`. Codex separately read their
Ad/ad-set/campaign state histories bounded by the same cutoff and confirmed
ACTIVE/ACTIVE/ACTIVE and matching parent identities for both.

| Ad suffix | Actual spend | Actual ROAS | Stressed ROAS | Same-core sensitivity | Served recommendation |
| --- | ---: | ---: | ---: | --- | --- |
| 295620042 | 208.20 | 1.2680115274 | 1.4753121998 | Cut in original and peer-free profiles | Manual pause, confidence at most medium |
| 342030042 | 205.87 | 1.5172196046 | 1.7337640258 | Keep under stress | No manual pause; retain evidence hold |

Both windows cover ten economic days, September 16–25. Nine days have
bracketed purchase intent, one has only a point observation; six lack verified
historical objective. Target ROAS is 2; break-even is 1.71. September 16 has
zero revenue and spend 21.58 / 22.29 respectively. Its hypothetical revenue
becomes 43.16 / 44.58 only inside the sensitivity input. Actual metrics, the
admitted window and provider authorization are unchanged.

The offline serving replay composes the actual producer, v19 canonical
evaluation, persisted-JSON projection, native read model, OS presenter and
buyer-facing adapter. It records one positive and one refused recommendation,
and asserts no provider-write authority. Its selected-Ad generation and
presentation flags are explicitly synthetic. It does not claim full-account
generation admission, live navigation, a database round trip or causal lift.
The full original capture is preserved when current code adds sensitivity
evidence; differences are reported, not rewritten as historical observations.

Reproduce with retained local artifacts:

```sh
node --import tsx scripts/creative-decision-center/native-manual-cut-advisory-serving-replay.ts \
  --capture <original-capture.json> \
  --identities <same-cutoff-identities.json> \
  --out <serving-replay.json>
```

Pure/production-core tests additionally cover mixed profitable/losing point
days, recent recovery, low-P25 original-profile recovery, no point days,
source/receipt gaps, conflicts, wrong identities/manifests, stale/retained
presentation, inactive hierarchy, deterministic hashes and v18 readability.
Native decision epoch and D036 hysteresis remain unchanged; only the native
evaluation evidence contract moves to v19.

This acceptance is limited to the new recommendation path. Scale/Refresh
sample floors, historical configuration authority and all provider-write
controls remain separate requirements. No arbitrary 24-hour wait is part of
this offline check.

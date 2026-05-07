# 24-30. Observability, Overrides, Security, Meta Dependencies, DB, Reproducibility, Validation

## Observability Plan

Required metrics:

| Metric | Dimensions |
|---|---|
| decisionCenter enabled accounts | businessId hash, plan, flag |
| total creatives processed | businessId hash, account count, range |
| row decision distribution | buyerAction, primaryDecision, problemClass |
| aggregate decision distribution | aggregate action, scope |
| diagnose_data rate | field missing, account |
| missingData rate by field | field, buyerAction attempted |
| fix_delivery/fix_policy/watch_launch emitted count | proof status, confidence |
| scale/cut/refresh/protect counts | actionability, confidenceBand |
| high-confidence action count | buyerAction, missingData=false |
| high-priority low-confidence count | buyerAction, reason |
| legacy vs V2.1 conflict rate | before bucket, after buyerAction |
| stale data rate | account/date |
| benchmark missing rate | scope |
| adapter fallback rate | fallback reason |
| UI consumers still reading legacy fields | component name/static check |

Alerts:

| Alert | Threshold |
|---|---|
| diagnose_data spike | >40% or 2x 7-day baseline |
| missingData spike | field >25% |
| high-confidence with missing required fields | any |
| sudden scale/cut spike | >2x baseline |
| shadow conflict rate | >5% or any severe conflict |
| snapshot generation failure | >1 consecutive run/account |
| old snapshot adapter failure | any |

Log shape:

```ts
{
  eventName: "decision_center.row_decision_emitted",
  businessIdHash: string,
  accountIdHash?: string,
  snapshotId: string,
  engineVersion: string,
  adapterVersion: string,
  configVersion: string,
  primaryDecision: string,
  buyerAction: string,
  problemClass: string,
  actionability: string,
  confidenceBand: string,
  priority: string,
  missingData: string[],
  dataFreshnessHours?: number,
  benchmarkReliability?: string,
  targetSource?: string
}
```

Use hashed IDs in logs. Do not log creative names, copy, URLs, tokens, or raw customer data.

## Manual Override / Human In The Loop

MVP recommendation: defer decision-affecting overrides. Ship UI-only dismissal first.

| Capability | MVP | Storage | Effect |
|---|---|---|---|
| Mark recommendation wrong | defer | future audit table | should not rewrite engine |
| Dismiss Today Brief item | yes | user preference table/local server state | hides item for actor/snapshot only |
| Manually protect creative | defer or flag | override table | future resolver input with audit trail |
| Known test / do not cut | defer | override table | caps cut |
| Strategic asset / brand exception | defer | override table | caps cut/refresh |

Override schema:

```ts
{
  id: string;
  businessId: string;
  actorUserId: string;
  scope: "creative" | "ad" | "family";
  entityId: string;
  overrideType: "dismiss" | "protect" | "known_test" | "brand_exception" | "wrong_recommendation";
  reason: string;
  createdAt: string;
  expiresAt?: string | null;
  appliesToEngine: boolean;
}
```

Rule: drawer always shows engine output and override separately.

## Security And Tenant Isolation

Evidence:

| Evidence | File |
|---|---|
| `requireBusinessAccess` requires auth, reviewer access, active membership, role | `lib/access.ts` lines 148-181 |
| Creative decision route calls `requireBusinessAccess` | `app/api/creatives/decision-os/route.ts` lines 82-115 |
| V2 preview route calls `requireBusinessAccess` | `app/api/creatives/decision-os-v2/preview/route.ts` lines 45-78 |
| Meta creatives route calls `requireBusinessAccess` | `app/api/meta/platforms/meta/creatives/route.ts` lines 53-69 |
| Meta history route calls `requireBusinessAccess` | `app/api/meta/platforms/meta/creatives/history/route.ts` lines 20-28 |

Security risks:

| Risk | Severity | Mitigation |
|---|---|---|
| Snapshot response leaks raw copy/URLs in generated reports | high | fixture extraction redacts creative names, copy, URLs, tokens |
| Read-only spike accidentally writes | high | scripts must not import route POST/save helpers or mutation functions |
| Cross-tenant snapshot access | high | keep `requireBusinessAccess`; test wrong business access |
| Debug params leak media/copy | medium | block debug in generated reports |
| Logs expose account/creative names | medium | hash IDs and omit names/copy |

Safe fixture rules: keep only IDs hashed/anonymized, numeric metrics, statuses, reason tags, missing fields, and expected assertions.

## Meta API Dependency And Rate Limit

| Field | Current code evidence / likely source | Permissions/risk | Must-have |
|---|---|---|---|
| effectiveStatus | `/ads` effective_status filter exists | low/medium; expose field | MVP for policy/delivery |
| reviewStatus | unknown exact field; inspect Meta ad review fields | app review unknown | MVP for policy |
| disapprovalReason | unknown exact field | app review/rate risk unknown | MVP for policy confidence |
| limitedReason | unknown exact field | unknown | MVP for policy confidence |
| firstSeenAt | ad `created_time` currently fetched | low | MVP partial |
| firstSpendAt | derive earliest insight spend date | warehouse query cost | MVP for launch |
| spend24h/impressions24h | Meta insights daily/today or warehouse current day | rate risk if live-read; prefer stored | MVP for delivery |
| CTR/CPM/frequency trend | warehouse daily windows | low if stored | MVP for refresh confidence |
| placement breakdown | `MetaBreakdownType` includes placement | storage exists | nice-to-have |
| campaign/adset/ad status | ads/campaign/adset dimensions | medium | MVP |
| creative asset metadata | creative nested fields already fetched | medium | MVP identity partial |
| video metrics | existing video rates | low | nice-to-have |

Use stored synced data, not live Meta reads, for Decision Center. If Meta sync is stale, hard actions become `diagnose_data`.

## DB / Schema / Backfill Plan

| Object | Suggested persistence |
|---|---|
| feature row | `creative_decision_feature_rows` or JSON inside snapshot; includes identity grain/status/windows/target/freshness |
| row decision | JSONB in decision snapshot initially; relational table only if query needed |
| aggregate decision | JSONB in decision snapshot |
| config | `creative_decision_configs` with business/account/campaign overrides |
| audit log | `creative_decision_audit_events` for emitted rows, conflicts, overrides |
| snapshot | existing snapshot table extended additively or new `decision_center` JSONB |

Every snapshot must include `engineVersion`, `adapterVersion`, `configVersion`, `dataFreshness`, `generatedAt`, `inputCoverageSummary`, `missingDataSummary`.

## Snapshot Reproducibility

Test plan:

| Check | Requirement |
|---|---|
| same feature rows + config + engine/adapter version | byte-stable output except generatedAt if injected |
| no `Date.now` in resolver | injected clock only |
| no randomization | deterministic sorting |
| no hidden network call | pure resolver/adapter package |
| config version recorded | snapshot metadata |
| reason ordering deterministic | stable priority order |
| Today Brief ordering deterministic | priority desc, confidence desc, stable creativeId |

## Runtime Contract Validation

Repo does not currently use Zod in dependencies. Use custom validators or add Zod only if accepted as a dependency. Initial recommendation: TypeScript contracts plus small runtime validators in `lib/creative-decision-center/validators.ts`.

| Contract | Invalid behavior |
|---|---|
| V2.1 engine output | fail tests; shadow skip row |
| buyer adapter output | fail tests |
| decisionCenter snapshot | API returns safe fallback with validation error |
| aggregate decision | drop invalid aggregate and log |
| config | fallback to default config and log |
| old snapshots | adapt then validate; if invalid show legacy drawer |


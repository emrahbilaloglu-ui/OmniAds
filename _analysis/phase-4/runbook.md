# Engine v3 Operator Runbook

Single-operator product (Erhan). This is a reference, not a tutorial. Reach for it when something looks off or when you need to flip a flag fast.

## Quick map

- **Engine source**: `lib/creative-decision-engine/` (do not modify; v3 is the system of record)
- **Archive (R&D only)**: `lib/archive/v1-v2-v21/` (V1/V2/V2.1 + Meta campaign-level engine; ESLint blocks serving code from importing this)
- **Jobs**: `lib/creative-decision-engine/jobs/` — calibration → lifecycle → decisions → operator-response (in dependency order, daily)
- **Feature flags resolver**: `lib/creative-decision-engine/feature-flags.ts`
- **API**:
  - `GET /api/creatives/decision-engine-v3` — strip data (decisions + flags + dataHealth + accountProfile)
  - `GET /api/creatives/decision-engine-v3/evidence?creativeId=…` — per-creative drawer evidence (lazy)
  - `GET /api/admin/engine-v3/readiness?businessId=…` — ops dashboard JSON (jobs + dataHealth + gating)
  - `PATCH /api/admin/engine-v3/preset` — body `{ businessId, preset: "aggressive"|"balanced"|"conservative"|null }` (admin-only)
- **UI**:
  - Strip: `components/creatives/CreativeDecisionEngineV3Surface.tsx` (preset dropdown + Account profile disclosure live here)
  - Drawer evidence: `components/creatives/CreativeEngineV3EvidenceSection.tsx`
  - Grid badges: `components/creatives/CreativeDecisionLabelBadge.tsx` (used by `CreativesTopGrid.tsx`)

## Feature flags

Three flags per business, NULL means "inherit env default":

| Flag | Env default | Purpose |
|---|---|---|
| `enabled` | `DECISION_ENGINE_V3_ENABLED` (true) | Engine runs at all for this business |
| `surface_visible` | `DECISION_ENGINE_V3_SURFACE_VISIBLE` (false) | Strip + grid badges + drawer evidence visible |
| `shadow_only` | `DECISION_ENGINE_V3_SHADOW_ONLY` (true) | When true, hard actions (scale/cut/refresh) softened |
| `preset_override` | n/a (no env) | Force preset; bypasses target_pack risk posture |

DB connection: `postgresql://adsecute_app:…@127.0.0.1:15432/adsecute_prod` (port-forwarded SSH tunnel; check `.env.local` for current secret).

### Flip flags by SQL

```sql
-- Live mode for a business (UI on, hard actions enabled, no preset override)
INSERT INTO business_engine_v3_flags (business_id, surface_visible, shadow_only, updated_by)
VALUES ('<business-id>', TRUE, FALSE, 'manual')
ON CONFLICT (business_id) DO UPDATE SET
  surface_visible = TRUE,
  shadow_only = FALSE,
  updated_at = NOW(),
  updated_by = 'manual';

-- Hide the v3 surface (engine still runs)
UPDATE business_engine_v3_flags SET surface_visible = FALSE WHERE business_id = '<id>';

-- Kill switch (engine stops running for this business)
UPDATE business_engine_v3_flags SET enabled = FALSE WHERE business_id = '<id>';

-- Force preset
UPDATE business_engine_v3_flags SET preset_override = 'aggressive' WHERE business_id = '<id>';

-- Clear preset override (revert to target_pack chain)
UPDATE business_engine_v3_flags SET preset_override = NULL WHERE business_id = '<id>';

-- Show current state
SELECT business_id, enabled, surface_visible, shadow_only, preset_override, notes
FROM business_engine_v3_flags;
```

### Flip preset via UI

Strip header → preset dropdown → pick value. "Clear override" link appears when `presetSource === "business_engine_v3_flags_override"`. The mutation hits `PATCH /api/admin/engine-v3/preset` and invalidates the decisions query.

## Jobs

Daily order (each must finish before the next):

1. `engine_v3_calibration_job` — per-business per-format percentiles (CTR, thumb-stop, funnel rates) into `engine_v3_account_calibration_daily`
2. `engine_v3_lifecycle_job` — per-creative classification + funnel diagnosis into `engine_v3_creative_lifecycle_daily`
3. `engine_v3_decisions_job` — per-creative final decision snapshot into `engine_v3_decision_snapshots_daily` + change events into `engine_v3_decision_events`
4. `engine_v3_operator_response_job` — detect operator response in budget/status changes, write into `engine_v3_decision_events`

All jobs are flag-gated (`enabled` flag must be TRUE) and write to `engine_v3_job_runs` with status / error_json.

### Recent job state

```sql
SELECT job_name, status, started_at, finished_at, error_json
FROM engine_v3_job_runs
WHERE business_id = '<id>'
ORDER BY started_at DESC
LIMIT 20;
```

### Manual job trigger

Call from a tsx script or REPL:

```typescript
import { runDecisionsJob } from "@/lib/creative-decision-engine";

const result = await runDecisionsJob({
  businessId: "<id>",
  asOf: new Date().toISOString().slice(0, 10),
});
console.log(result);
```

Same pattern for `runLifecycleJob`, `runOperatorResponseJob` (calibration job has its own export — check `jobs/calibration-job.ts`).

## DB recipes

```sql
-- Most recent decisions for a business
SELECT creative_id, label, reason, confidence, computed_at
FROM engine_v3_decision_snapshots_daily
WHERE business_id = '<id>'
ORDER BY computed_at DESC
LIMIT 50;

-- Label distribution last 24h
SELECT label, COUNT(*) AS n
FROM engine_v3_decision_snapshots_daily
WHERE business_id = '<id>' AND computed_at > NOW() - INTERVAL '24 hours'
GROUP BY label
ORDER BY n DESC;

-- Mature creative count (most recent calibration)
SELECT mature_creative_count, computed_at
FROM engine_v3_account_calibration_daily
WHERE business_id = '<id>' AND scope_type = 'account' AND scope_id = '*' AND creative_format = 'overall'
ORDER BY as_of_date DESC, computed_at DESC
LIMIT 1;

-- Funnel diagnosis snapshot for one creative
SELECT primary_weak_stage, creative_responsible, confidence, evidence
FROM engine_v3_creative_lifecycle_daily
WHERE business_id = '<id>' AND creative_id = '<creative-id>'
ORDER BY as_of_date DESC
LIMIT 1;

-- Operator response detection events
SELECT *
FROM engine_v3_decision_events
WHERE business_id = '<id>' AND creative_id = '<creative-id>' AND event_type LIKE 'operator_%'
ORDER BY occurred_at DESC
LIMIT 10;

-- Target pack (where preset comes from when no override)
SELECT business_id, target_roas, break_even_roas, default_risk_posture
FROM business_target_packs
WHERE business_id IN ('<id>', '<id>');
```

## UI controls

- **Strip header**:
  - Distribution counts (Scale: N, Cut: N, …)
  - "Shadow mode (advisory only)" badge — only when `shadow_only=true`
  - Data tier badge (yellow=warning >36h stale, red=degraded >72h)
  - Last updated timestamp
  - Preset dropdown + "Clear override" link
  - "Account profile" disclosure (preset/spendUnit/multipliers/quality flags)
- **Grid thumbnail**: top-right small label badge (Scale/Keep/Refresh/Cut/Test more/Diagnose) — gated by `enabled && surface_visible`
- **Drawer evidence section** (last section in CreativeDetailExperience): six accordions
  - Decision (label + reason + confidence + truth source + effective target / ratio)
  - Inputs (CreativeInput fields)
  - Funnel (FunnelDiagnosis: primary weak stage + per-stage rates + evidence)
  - Engine trail (badges + quality flags + hard-action eligibility)
  - Operator response (OperatorResponseResult or "no response detected")
  - Provenance (engine version + as-of + per-layer DataHealth)

## Troubleshooting

### Strip not visible
- `enabled` is false (flag override) → SQL: enable
- `surface_visible` is false (env default) → SQL: surface_visible=true override OR set `DECISION_ENGINE_V3_SURFACE_VISIBLE=true` in `.env.local`
- Endpoint 500 → check next item

### `/api/creatives/decision-engine-v3` returns 500
First suspects (in order):
- Missing migration. Tables that must exist: `business_engine_v3_flags`, `engine_v3_job_runs`, `engine_v3_account_calibration_daily`, `engine_v3_creative_lifecycle_daily`, `engine_v3_decision_snapshots_daily`, `engine_v3_decision_events`, plus `business_target_packs` and `business_decision_calibration_profiles`. Run `\d <table>` in psql; if missing, manually apply the matching migration block from `lib/migrations.ts` (Next.js dev's runMigrations sometimes skips on advisory lock conflict).
- DB connection: `psql "$DATABASE_URL" -c 'SELECT 1'`
- Inspect server log: `tail -200 /tmp/adsecute-dev.log`

### Drawer evidence "unavailable"
Same root cause family as above — endpoint 500, table missing, OR creativeId mismatch (drawer's `row.id` vs engine `CreativeInput.creativeId`). Check `/api/creatives/decision-engine-v3/evidence?businessId=…&creativeId=…` directly with curl to see status + error body.

### Jobs stale (>24h)
- Calibration is the entry — if it's stale, downstream jobs gate themselves and write nothing
- Manual run with the snippet above
- Check `engine_v3_job_runs.error_json` for the specific failure
- Common: meta_creative_daily freshness is bad → check `meta:state-check` script

### Decisions look wrong / counter to expectation
- Account profile in strip: spendUnit / preset / multipliers / quality. If `commercialTruthReady=false`, profile is degraded.
- DataHealth tier: degraded → engine runs in degraded mode (some gates disabled)
- Funnel diagnosis in drawer: shows what the engine "sees"
- If still wrong: ship `_analysis/phase-5/comparison.csv` and tune from there (see Phase 5 plan)

### Hard action you didn't expect (cut/scale/refresh going live)
- `shadow_only=true` would have softened it. If hard action surfaced, shadow_only is false (live mode) — by design now.
- Operator response detection should pick up your override and feed back into the decision next cycle.

## Phase 5 entry point

`_analysis/phase-4/runbook.md` is the operational reference. Phase 5 (validation) lives in `_analysis/phase-5/` (TBD): 5-way label comparison (v3 / my labels / 3 Codex personas) on the same 6-category rubric, run as soon as Phase 4 closes.

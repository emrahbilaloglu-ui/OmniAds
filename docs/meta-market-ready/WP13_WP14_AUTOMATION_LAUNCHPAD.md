# WP13 / WP14 — Automation and Launchpad read/draft/validate

Work packages: WP13 and WP14 of
`docs/meta-market-ready-master-plan-2026-08-22.md`
Depends on: WP0–WP12
Date: 2026-08-22

## 1. WP14's defect: a failed pixel read wiped the operator's choice

`LaunchpadAdSets` cleared `pixelId` on every ad set whenever the pixel list came
back empty:

```ts
if (!pixelsLoading && sortedPixels.length === 0 && adSet.pixelId) {
  return { ...adSet, pixelId: "" };
}
```

The list was set by `Array.isArray(payload?.pixels) ? payload.pixels : []` with a
`.catch(() => setPixels([]))`. So a 401, a 500, an offline moment, or a 200
carrying an unexpected shape **all produced the same `[]`** — and the operator's
chosen pixel was silently deleted from every ad set in a draft they may have
spent minutes building.

An empty list has two causes that call for opposite handling. If the read
succeeded and the account owns no pixels, a stored `pixelId` names something
that does not exist and would be refused by Meta; clearing it is correct. If the
read **failed**, we do not know what the account owns, and clearing destroys
work. This is D8 on a form rather than on a metric: an unread source is not a
source with nothing in it.

**Fixed:** `pixelsProvenEmpty` tracks whether a read actually succeeded and
returned zero. A non-2xx short-circuits before parsing (the old `.json()` parsed
the *error body*, found no `pixels` key, and produced the healthy-empty result).
Clearing happens only on a proven-empty account.

Verified to fail against the previous code: stashing the fix turns 3 of the 4
new cases red.

## 2. WP14 items already correct

| Item | State |
|---|---|
| 1. recent-actions response unwrapped | **satisfied** — `loadRecentLaunchpadAdActions` reads `payload.actions` and type-guards the array |
| 3. picker checks `response.ok` | **satisfied for pixels** (now), and the launchpad JSON reader already guards shape for templates/drafts/intents |
| 6. bulk and cardinality limits in validate | **satisfied** — WP1 surfaced `evaluateMetaLaunchpadExecutionBounds` on the review step, using the same function both write routes run |
| 11. execution flag off | **satisfied** — WP1's `META_LAUNCHPAD_EXECUTION`, default off, enforced on the server |

## 3. WP14 items not done

| Item | Status |
|---|---|
| 2. capability unavailable state | **partial** — `launchIntentCapability` already produces a disabled reason on the review step (WP1); a dedicated unavailable *state* for the library reads was not built |
| 5. draft update/delete callers | **not audited** |
| 7. kill-switch refusal into the viewer envelope | **partial** — WP7 put the kill switch on the server for both write routes; surfacing it *pre-click* in the viewer envelope was not built |
| 8. current-ads projection counts PAUSED correctly | **not audited** |
| 9. candidate vs current-state windows shown separately | **partial** — WP5 named the candidate window honestly and the registry marks Launchpad `mixed`; rendering both is not built |
| 10. receipt/handoff state preserved through validate | **not audited** |

## 4. WP13 — Automation

Most of WP13 landed in WP1 and WP7. What remains is recorded here rather than
restated as done.

| Item | State |
|---|---|
| 1. WP1 copy and posture | **satisfied** — Meta-only labels, the Google-unaffected sentence, `dryRunOnly` visible, the dry-run approval notice |
| 2. Meta Stop engage at collaborator+ | **satisfied on the server** — `requireBusinessAccess` uses `collaborator` for `engage_kill_switch` |
| 3. Meta Stop release at admin | **satisfied on the server** — `release_kill_switch` and `set_guardrail_policy` both take the `admin` floor |
| 5. a POST does not produce a success banner | **satisfied** — WP1 §2.4: the approval notice restates the receipt's own `dryRun`, including the absent case |
| 8. `dryRunOnly` defaults TRUE | **satisfied** — both in the column and in `readMetaAutomationPosture`, written as its own reading so deleting the live gate leaves the safe posture |
| 11. Google-unaffected copy fixed | **satisfied** — WP1 §2.1, pinned by `meta-only-scope.test.ts` |

### 4.1 The Meta Stop UI does not exist, and that is the correct state

D10 says: *"Engage/release reversibility kanıtlanmadan stop UI aktif edilmez."*

The mounted Automation body has **no engage/release control**. The kill card is
`data-read-only="true"` and renders status only. So the shipped state already
satisfies D10, and `META_AUTOMATION_STOP_UI` (defined in WP1) is the gate for
when the control is built.

Building it now would mean adding a write control the design does not draw,
before its release-reversibility has been proven in a sandbox — which is what
D10 and §18 both forbid. Recorded as deliberately absent, not as missing.

### 4.2 Items 4, 6, 7, 9, 10 — not built

- **4. typed confirm** and **10. proposal approve refusal paths** — the proposal
  path already requires `MANUAL_CONFIRMATION` and produces a dry-run receipt;
  the *typed* confirmation ceremony for the stop control belongs with the
  control, which does not exist.
- **6. decision-type mode selector** — the server action
  (`set_decision_type_mode`) exists and is role-gated; no UI draws it.
- **7. audited admin writer for guardrail policy** — the route enforces the
  `admin` floor and the reviewer/demo guards; a separate audited writer was not
  built.
- **9. live automation behind its own gate and canary** — the gate exists
  (`META_AUTOMATION_LIVE_WRITES`, default off, with `openGatesWithMissingSteps`
  from WP7 asserting conformance before it may open). The canary is WP18 and
  needs approval.

## 5. Gate results

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS** |
| lint | `npx eslint .` | **PASS** |
| unit + integration | `npx vitest run` | **PASS** — 12 590 passed, 0 failed (WP12: 12 586; +4) |

## 6. Rollback

Surface-local. The pixel change is one hook and one condition in
`LaunchpadAdSets.tsx`; reverting restores the previous clearing behaviour.

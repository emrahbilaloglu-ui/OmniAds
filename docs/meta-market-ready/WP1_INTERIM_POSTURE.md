# WP1 — Safe and honest interim posture

Work package: WP1 of `docs/meta-market-ready-master-plan-2026-08-22.md`
Depends on: WP0 (`3bf9cd460`)
Date: 2026-08-22

## Goal

Close, without lying about it, the paths that look like they work today but are
not safe to run.

## 1. Launchpad execution is gated, disabled-with-reason

| Plan item | Change | Evidence |
|---|---|---|
| 1.1 Create PAUSED / Add to existing disabled-with-reason | `META_LAUNCHPAD_EXECUTION` gate; the review screen states the refusal | VERIFIED-STATIC |
| 1.2 Draft / template / intent / validate keep working | Untouched — the gate sits only on the two create endpoints | VERIFIED-STATIC |
| 1.3 Server routes remain the defence layer | `rejectIfLaunchpadExecutionGated` in both write routes | VERIFIED-STATIC |
| 1.4 Bulk cap visible in the UI | Execution-size panel on the review step | VERIFIED-STATIC |

### 1.1 Where the gate is enforced

The refusal lives on the **server**, in
`app/api/launchpad/meta/route-utils.ts`, and both write routes call it:

- `app/api/launchpad/meta/launch/route.ts`
- `app/api/launchpad/meta/add-to-existing/route.ts`

It is placed **after** the access / reviewer / demo checks and **before** every
provider-facing step. That ordering is asserted, not assumed: the route test
`refuses before resolving an account when the execution gate is closed` proves
`resolveAssignedMetaLaunchAccount`, `prepareMetaLaunchIntentForExecution` and
`createCampaign` are all uncalled. A closed gate therefore costs no credential
read and no Meta call, however many times a request is replayed.

`503`, not `403`. Nothing is wrong with the caller's authority and the same
request succeeds unchanged once execution is enabled; a `403` would send an
operator who already holds every permission off to ask for permissions.

The screen restates it — it never decides it.
`app/c/[businessId]/meta/launchpad/page.tsx` reads the gate server-side and
forwards `executionEnabled`; the body treats anything other than an explicit
`true` as closed, which is the same fail-closed reading the viewer envelope
already used for `not_established`.

**Precedence:** viewer refusal first, gate second. A reviewer is told they are
read-only rather than that the product is not ready, because that is the fact
they can act on. Both refusals hold regardless of which sentence is shown, and
`still refuses a reviewer first when the gate is also closed` pins it.

### 1.2 The disabled control is reachable by keyboard and screen reader

`Create PAUSED` now uses `aria-disabled` rather than `disabled`, with
`aria-describedby` pointing at the refusal sentence and a click handler that
returns early on the same condition.

A `disabled` button is removed from the tab order, so a keyboard or
screen-reader user reached the end of the wizard and found *nothing* — control
and reason both unreachable, indistinguishable from the feature not existing.
That is the plan's D13 and the WP1 acceptance item about the reason being
accessible. The control is now inert in fact, not only in appearance.

### 1.3 Bulk caps are visible before the click, not discovered as a 413

The review step renders `evaluateMetaLaunchpadExecutionBounds` — **the same
function both write routes run** — showing planned provider creates against
`maxPlannedProviderCreates`, creatives against `maxCreatives`, and ad
sets/targets against their ceiling, plus any blocker message. Restating the
server's arithmetic rather than reimplementing it is what stops the two
drifting.

### 1.4 No new provider write

The WP1 acceptance requires that none be added. None was: this work package
adds one refusal to each of the two existing write routes and changes nothing
about what they do when the gate is open. `npx vitest run app/api/launchpad`
passes 211/211.

## 2. Automation tells the truth about its scope

### 2.1 The kill switch is Meta-only — a claim, now grounded

The screen said **"Global writes"** and **"Flipping either switch blocks every
provider write instantly"**. Both are false.

`META_ADS_WRITE_KILL_SWITCH` is read by `lib/meta/ads-write.ts`, the Meta
automation control plane and the Meta routes. `lib/google-ads/advisor-mutate.ts`
neither reads it nor imports anything from `@/lib/meta/`. An operator reaching
for that switch during an incident would have believed Google Ads had stopped
too — the plan's rollback trigger 9.

Now:

- `Meta writes · all businesses` / `Meta writes · this business`
- "Flipping either switch blocks every **Meta** write instantly —
  server-enforced, not a UI state. **No control on this screen stops Google Ads
  writes.**"
- the mobile summary carries the same scope sentence.

`app/(dashboard)/platforms/meta/automation/meta-only-scope.test.ts` pins the
*reason* rather than the wording: it asserts the Google mutate path reads
neither the flag nor any `@/lib/meta/` module. A future edit restoring the
design's wording has to first make the wording true.

### 2.2 Deviation from the visual authority — recorded, not hidden

The design file at `2af6cbaf…` itself contains "Global writes" and "blocks
every provider write instantly". This work package **deviates from the visual
authority on that copy**, under:

- plan D1, which lists "yanlış veya riskli mikro metin" among the permitted
  micro-changes;
- plan WP1 items 5–6, which mandate exactly this correction;
- `docs/adr-005-visual-vs-vendored-authority.md` rule 2 — the visual file
  governs appearance, and a sentence about what a control *does* is behaviour.

Layout, hierarchy, card structure and styling are untouched. Only the two false
sentences changed, and one true one was added.

### 2.3 `dryRunOnly` is now visible

`dryRunOnly` decides whether anything on the screen can reach Meta at all, and
it was the one guardrail the card did not show. The operator was reading four
limits on writes while the fifth fact — that there are no writes — went
unstated, which made an approval look like an action. It renders as
**"Approvals reach Meta — No, dry run only"**, from the served value, with `—`
when the control read failed.

### 2.4 A dry-run approval says so

A successful approval used to render nothing, so an approval that
short-circuited before the provider POST — which is *every* approval in the
only configuration production can reach — looked exactly like one that changed
something on Meta. The row left the queue and the operator drew the obvious
conclusion.

The receipt's own `dryRun` flag is now restated in three states:

- `true` → "Recorded as a dry run — **nothing was sent to Meta.**"
- `false` → "Approved and dispatched to Meta."
- absent → "…whether anything reached Meta is unknown — check the activity
  ledger before approving it again."

The third case matters: guessing "sent" invents a write, guessing "not sent"
hides one.

### 2.5 Read failures carry the server's own code

The client collapsed every failure into `automation_control_plane_unavailable`,
so an operator whose token had expired was told "Automation could not be read" —
true, and useless. `READ_FAILURE_MESSAGES` has had a sentence per code all
along; nothing was reaching it.

`AutomationReadError` now carries the route's code to the render, and the
dictionary gained `automation_contract_failed`, `unauthorized` and `forbidden`.
A transport failure that never reached the route still degrades to the general
code — guessing *which* failure would replace one lie with another.

## 3. Gate results

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS**, 0 errors |
| lint | `npx eslint .` | **PASS**, exit 0 |
| unit + integration | `npx vitest run` | **PASS** — 12 403 passed, 144 skipped, 63 todo, **0 failed** (was 12 389 passed at WP0; +14) |
| Launchpad API | `npx vitest run app/api/launchpad` | **PASS** — 211/211 |

New coverage: `lib/meta/release-gates.test.ts` (10),
`app/api/launchpad/meta/execution-gate.test.ts` (6),
`app/(dashboard)/platforms/meta/automation/meta-only-scope.test.ts` (4), plus
two in-route ordering cases and strengthened assertions in the Automation
presentation test.

## 4. Runtime and provider evidence

**UNKNOWN.** No authenticated session, no live Meta account and no provider
call were exercised in this work package. Everything above is
**VERIFIED-STATIC**. Runtime confirmation is WP18's staged release, and the
plan's start-instruction rule 9 forbids production DB/provider writes or deploys
without explicit approval, which has not been given.

## 5. Rollback

Surface-local, and in two independent pieces:

- **Launchpad:** revert the two route hunks and the `executionEnabled` prop.
  Setting `META_LAUNCHPAD_EXECUTION=true` restores the previous behaviour
  without any code change, which is the intended operational lever.
- **Automation:** the copy, the `dryRunOnly` row, the approval notice and the
  failure-code mapping are four independent hunks in one file and one test
  file; any can be reverted alone.

No schema, no migration, no provider state, no deployed configuration.

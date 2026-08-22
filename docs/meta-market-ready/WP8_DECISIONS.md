# WP8 — Decisions

Work package: WP8 of `docs/meta-market-ready-master-plan-2026-08-22.md`
Depends on: WP0–WP7
Date: 2026-08-22

## 1. The finding

`/api/meta/decision-workflow` has carried all seven transitions —
`assign`, `acknowledge`, `defer`, `snooze`, `reject`, `resolve`, `reopen` —
with `expectedVersion` optimistic concurrency for some time. Its **only caller**
lived in `components/zero-base/meta/decisions/decisions-client.tsx`.

**No route mounts that body.** `/c/[businessId]/meta/decisions` mounts
`MetaPlatformPage`, which never called the endpoint. That is the plan's §5.1
finding 14, and an instance of the pattern recorded in
`project_zero_base_bodies_unmounted`: a feature written, tested, and reachable
by nobody.

D2's answer is to **port the behaviour into the production visual owner**, not
to mount the zero-base body — §17.3 forbids a wholesale zero-base mount.

## 2. What was built

| File | Role |
|---|---|
| `lib/meta/decision-workflow-client.ts` | the **one** network implementation, shared by both bodies |
| `lib/meta/decision-workflow-limits.ts` | the key cap, shared with the route |
| `components/meta/redesign/use-decision-workflow.ts` | the read/submit hook for the mounted body |
| `components/meta/redesign/decision-workflow-view-model.ts` | composes the inspector's Workflow section |
| `MetaDecisionCenterExact.tsx` + `.module.css` | renders it inside the existing Evidence inspector |

`decisions-client.tsx` was repointed at the shared module, so there is one
implementation rather than two copies that could drift about what a 409 means
or which field carries the version.

### 2.1 Rules encoded, each of which the surface would otherwise get wrong

- **An unread overlay is `unknown`, never `open`.** Rendering the default state
  for a failed read claims nobody owns these decisions — a statement about other
  people's work made on no evidence. A 200 whose body cannot be parsed is also
  a failed read.
- **A missing assignee is the unavailable mark, not "Unassigned".** The record
  says there is no assignee; it does not say nobody is working on it.
- **A 409 is a conflict, not an error.** Nothing was applied, and the server
  returns the **current** record — showing that beats telling the operator to
  reload and guess. The surface replaces its copy from the server's record
  rather than patching locally, because a local guess at the next state is a
  second state machine.
- **A submit that never came back is `unknown`.** Not "failed", not "applied".
  The overlay re-reads rather than displaying a state nobody confirmed.
- **Offering is presentation; permitting is the server's.** The hook offers only
  the transitions a state allows, so the surface does not invite a click the
  server will refuse — but it never computes permission, which would be a second
  rule that can disagree with the first.

### 2.2 `expectedVersion` travels from what the operator saw

The submit carries `record.stateVersion` — the version rendered when they
decided — so a stale edit is refused with 409 instead of overwriting a change
they never saw. `passes the record to the handler so the submit carries the
version it saw` pins this: a handler that re-looked-up the record could send a
newer version and silently overwrite.

## 3. The design constraint, and how it was honoured

The design file draws the workflow's **output** — a `Deferred 2` watch-lane
segment and a row note "Let cook until Aug 15, 09:00" — and a row-level
`Dismiss` button. It draws **no** assign / acknowledge / snooze / resolve /
reopen controls and no owner assignment UI.

§18 of the plan says a write control the design does not carry is **not added on
this pass**: it ships absent-with-reason, or in a separately approved round.

So the whole overlay is behind **`META_DECISION_WORKFLOW_UI`, default off**, and
with the gate closed:

- **no read runs** — the gate governs the overlay, not only its buttons; reading
  anyway would spend a request per selection to render a section whose every
  control is refused;
- the inspector's Workflow section renders **absent-with-reason** rather than
  disappearing, because hiding it would read as "this product has no ownership
  model", which is false;
- **nothing the design draws is lost**: its `Deferred N` segment comes from the
  workspace payload's own `deferredCount`, not from this overlay.

With the gate open, the state renders and the seven actions become live. A
reviewer or read-only viewer is refused **first**, because that is the more
specific fact and the one they can act on.

The controls use `aria-disabled`, not `disabled` — a disabled button leaves the
tab order and takes its own explanation with it — and **12px**, not the design's
11.5px, because this is an added element and meets the readable floor rather
than inheriting an exemption granted to a different element.

## 4. Three repo gates caught real mistakes

Worth recording, because each was a genuine defect and not test friction:

1. `app/api/route-export-surface.test.ts` — exporting the key cap **from the
   route module** violates what Next accepts. Moved to
   `lib/meta/decision-workflow-limits.ts`.
2. `lib/typography-floor.test.ts` — the new control was 11.5px, below the
   readable floor, outside the reference-type marker. Raised to 12px.
3. `MetaPlatformPage.wiring.test.tsx` — an extra `fetch` on every selection.
   That was the signal that led to gating the read itself rather than only the
   buttons, which is the better design.

## 5. Items in WP8's list not addressed here

Stated rather than implied:

| Item | Status |
|---|---|
| mutation ceremony port; preflight route gets a real caller; read-age chip + "did not contact Meta" | **already present** in the mounted body — the D065/D067 preflight, `current_ad_state_stale`, and the tracking interstitial are all live on `MetaPlatformPage` |
| selected window vs decision as-of separated | **already present** — verified in WP5 §3: "queue reflects snapshot ⟨date⟩ — the date range scopes metrics, not decisions" |
| UI does not compute `buyerAction` | **already true** — the adapter selects server strings and never derives a verdict |
| `bidConfiguration` and entity facts visible; blocker/shield chip not droppable by slice; thumbnails and exact IDs; honest lane empty state | **not audited in this pass.** Each is a presentation claim about the exact body that needs a rendered comparison against the reference, which belongs with WP16's mounted visual gate. Claiming them from a code read would be exactly the kind of inference the plan's evidence classes exist to prevent |
| "Decisions label writer removed" | **not done.** The label-writing path was not located in this pass and is recorded as open rather than silently dropped |

## 6. Gate results

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS** |
| lint | `npx eslint .` | **PASS** |
| unit + integration | `npx vitest run` | **PASS** — 12 565 passed, 0 failed (WP7: 12 548; +17) |

New coverage: `decision-workflow-client.test.ts` (9),
`decision-workflow-view-model.test.ts` (8).

## 7. Runtime evidence

**UNKNOWN.** The plan's acceptance wants `acknowledge → defer → resolve` on a
real decision and an `expectedVersion` conflict integration test against a live
store. Both need an authenticated session and a database.

## 8. Rollback

`META_DECISION_WORKFLOW_UI` off is the operational lever and is the shipped
state. In code: reverting the `decisionWorkflowUiEnabled` prop chain removes the
feature; the shared client module is additive and `decisions-client.tsx` can be
repointed back at its own copy.

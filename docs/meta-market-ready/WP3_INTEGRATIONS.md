# WP3 — Integrations and provider-account assignment

Work package: WP3 of `docs/meta-market-ready-master-plan-2026-08-22.md`
Depends on: WP0–WP2
Date: 2026-08-22

Meta account assignment is the upstream precondition for every Meta surface
(D12). If it lies about what it saved, every surface downstream refuses for a
selection the product just confirmed.

## 1. What was already correct

Most of WP3's twelve items were already implemented, and to a high standard.
`lib/provider-assignment-service.ts` enforces, in this order: tenant access
before any credential read; a *current* connection rather than merely an
integration row; a bounded, provider-shaped request; membership in a fresh
discovery snapshot captured under **that credential generation**; canonicalised
ids; a locked write with an exact read-back inside the transaction; and — the
part most products get wrong — `selectionSaved` and `syncScheduled` reported as
two separate outcomes, with a 202 when the selection commits but no work is
enqueued.

The scheduling read-back in the Meta route is bound to an immutable
`schedulingAttemptId`, so a concurrent enqueue by another request cannot satisfy
it and clock skew cannot break it. An empty selection is treated as a safe
revocation that bypasses the freshness checks, on the correct reasoning that
those are the states in which an owner is *most* likely to want to revoke.

Confirming this against the plan's items is itself the work product for items
1–10 and 12. Below is what was **not** right.

## 2. Defect 1 — a demo workspace claimed a save that never happened

**Item 11.** The demo branch answered:

```
{ success: true, assigned_accounts: <the caller's own ids>, selectionSaved: true }
```

Nothing was written. No connection was checked, no discovery snapshot consulted,
and the ids were never validated against one — so the echoed list could name
accounts that do not exist. The operator saw a successful assignment, the drawer
closed, and every Meta surface then resolved no account and refused. The product
confirmed a selection and then behaved as though it had none.

**Fixed.** The response now carries `demo: true`, `persisted: false`,
`selectionSaved: false`, `success: false`, an empty `assigned_accounts` and a
sentence. Empty rather than echoed, because returning the request as its own
result *is* the defect; keeping the echo "for the UI" would preserve it exactly
where it does damage.

**No test covered this branch**, which is why it survived.
`lib/provider-assignment-demo.test.ts` now covers it in four cases, including
that the demo shortcut never runs before tenant authorization and never reaches
the connection or scheduling steps.

## 3. Defect 2 — the client discarded the outcome the server took care to produce

**Item 8.** `saveProviderAssignments` returned `{ assignedIds, error }`, which
cannot express what the server reports.

- **A 202 read as a clean success.** `response.ok` is `true` for a 202, so
  "selection saved, first sync could not be scheduled" closed the drawer with no
  message. The operator then waited for data that nothing was fetching.
- **On failure it returned the caller's own `draftIds` as `assignedIds`** — the
  request's input presented as its result. Also the fallback for a 200 whose
  body could not be read, so an unreadable success reported everything asked for
  as assigned.

**Fixed.** The function returns `{ assignedIds, error, selectionSaved,
syncScheduled, demo, notice }`. Every failure path returns `assignedIds: []`. A
200 without `selectionSaved: true` is not treated as a commit, because an
unreadable body is not evidence of a write.

The drawer now branches on all three outcomes: an error keeps the drawer open in
the destructive slot; a demo or uncommitted response keeps it open and says so;
a 202 **hands the saved ids upward first** and then reports the scheduling gap
in a separate warning slot — reusing the error slot would say the save failed,
and the obvious response to that is to save again.

`components/integrations/provider-assignment-outcome.test.ts` covers all seven
cases, including "never returns the caller's own draft ids as the result" across
four response shapes.

## 4. Defect 3 — a failed read rendered as "no accounts"

**Item 12.** The drawer had one empty state for two opposite facts:

> "No ad accounts found — No Meta ad accounts are available for this login **or
> the required permissions are missing**."

A read that succeeded and found nothing means the login owns no ad accounts, and
the operator should look at Business Manager. A read that *failed* — expired
token, permission denied, provider 5xx, refresh refused — means we do not know
what they own, and they should reconnect or retry. The "or…" hedge made the
honest case unreadable and the broken case look like a data fact, which is what
D8 forbids.

**Fixed.** A `degraded` state now sits beside `empty`, selected when
`meta.refreshFailed`, a non-null `meta.failureClass`, or
`sourceHealth === "degraded_blocking"` says the provider did not answer. It
renders "Account list unavailable … this is not a list of zero accounts — it is
a missing answer", carries the server's own notice when present, and offers
Retry. The proven-empty text drops the hedge and says what to do.

The route already produced every one of those fields; nothing was reading them.

## 5. Changes

| File | Change |
|---|---|
| `lib/provider-assignment-service.ts` | demo branch reports `persisted: false` and saves nothing |
| `components/integrations/provider-assignment-drawer-support.ts` | structured `ProviderAssignmentSaveOutcome`; no draft-id echo |
| `components/integrations/provider-assignment-drawer.tsx` | `degraded` state; separate notice vs error slots; 202 handling |
| `components/zero-base/manage/manage-clients.tsx` | comment corrected — the echo it described no longer exists |
| `components/zero-base/manage/manage-flows.test.tsx` | stub now sends the fields the real handler always sends |
| `lib/provider-assignment-demo.test.ts` | **new** — 4 cases |
| `components/integrations/provider-assignment-outcome.test.ts` | **new** — 7 cases |

## 6. Acceptance

| Plan acceptance item | Result | Evidence class |
|---|---|---|
| Authenticated 0/1/N account flows | **UNKNOWN** — needs a live session and a real Meta login | — |
| Stale snapshot, reconnect race, revoked credential, duplicate id, scheduling failure | **PASS (pre-existing)** — each has a typed refusal in `describeSelectionRefusal` and CAS guards in the write; verified by reading, not by running against a provider | VERIFIED-STATIC |
| Every Meta surface sees the same canonical account after assignment | **PASS (pre-existing)** — `validateRequestedProviderAccounts` persists the snapshot's canonical ids, not the caller's spelling | VERIFIED-STATIC |
| Real read-only DB schema and selection read-back proof | **UNKNOWN** — requires production-read-only DB access, which the plan gates behind explicit approval | — |

The three defects above are **VERIFIED-STATIC**: each is proven by a test that
fails against the previous behaviour.

## 7. Gate results

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS** |
| lint | `npx eslint .` | **PASS** |
| unit + integration | `npx vitest run` | **PASS** — 12 478 passed, 0 failed (WP2: 12 467; +11) |

## 8. Rollback

The UI assignment gate can close while every server guard stays. Specifically:

- reverting the drawer and its support module restores the previous client
  behaviour without touching authorization, validation or the write;
- reverting the demo hunk restores the previous claim and nothing else;
- both new test files are additive.

No schema, migration, provider state or deployed configuration is touched.

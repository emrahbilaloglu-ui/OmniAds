# WP4 — Shell and provider-account authority

Work package: WP4 of `docs/meta-market-ready-master-plan-2026-08-22.md`
Depends on: WP0–WP3
Date: 2026-08-22

Goal: remove the `account_required` dead-end and put every surface on one scope
model.

## 1. The dead-end, and why it was a dead-end

Three separate facts produced it.

**`null` meant three different things.** `resolveProviderAccountId` answered
`null` for a business with nothing assigned, for a business with several and no
choice made, and for a request naming an account the business does not have.
Those ask the operator for three different things — assign one, choose one, and
"that link is not yours" — and a surface handed a bare `null` could only offer
the same nothing for all three.

**There was no way to choose.** Decisions, History and Automation had each grown
their own picker. Account Intelligence and the entire Creative Studio family had
none. On those surfaces a business with several assigned Meta accounts could
reach a screen that refused for want of a selection with no control anywhere to
make one.

**`act_` spellings did not match.** Meta returns `act_123456` from some edges and
`123456` from others, and both are in links, stored assignments and pasted URLs.
Compared as raw strings, the same account failed to match itself, so a correctly
assigned account resolved to `null` and the surface refused for a selection that
was in the URL all along (§7.2).

### Fixes

`resolveProviderAccountScope` returns a typed outcome —
`provider_account_none_assigned`, `account_required`,
`provider_account_not_assigned`, or a resolved id — and
`resolveProviderAccountId` is now a thin wrapper over it, so the two cannot
disagree about what resolved. Meta ids are compared through
`sameMetaAccount`, and the id returned is always the **catalog's** spelling, so
cache keys, query parameters and receipts downstream all agree on one form. The
prefix rule is Meta-only: applying it to Google customer ids would make two
different customers compare equal.

An unassigned request still refuses **even when exactly one account is
assigned**. Asking for A and being handed B is the same defect whether or not B
happens to be the only option.

## 2. The shared account picker

`components/layout/v2/account-scope-control.tsx` sits in the topbar's existing
context slot, beside the business switcher and the date picker — D1's "mevcut
context alanında picker". No new layout, card or hierarchy.

D6's 0 / 1 / N, rendered:

| Assigned | Renders |
|---|---|
| none (no provider family) | nothing at all — a disabled control would imply an account question exists on Overview or Reports |
| 0 | "No Meta ad account", linking to Integrations, because the action that fixes this is assignment |
| 1 | the account **named**, not offered — a one-option dropdown reads as a decision the operator still owes |
| N, none chosen | "Select a Meta ad account" — **never** an auto-pick, because a figure attributed to an account nobody chose is worse than a refusal |
| N, one chosen | the account named and changeable |

It selects; it never grants. Choosing writes `?providerAccountId=` and nothing
else, and the server re-runs `resolveProviderAccountId` against this business's
assignments on the next render. A client-held selection would be a scope nobody
verified.

## 3. Changing account drops the previous account's state

`accountSwitchQuery` is an **allowlist**, for the same reason
`businessSwitchQuery` is: a blocklist has to enumerate every account-scoped
parameter in the tree and stays correct only until someone adds the next one.

Kept: the date window (days are not accounts) and a `businessId` the URL already
stated. Dropped: everything else — `row`, `creativeId`, `campaignId`, `adsetId`,
`entity`, `cursor`, `handoff`, `handoffDraft`, `launchpadMode`, `launchpadStep`,
`inspector`, and any parameter nobody has invented yet. A selected row or an
open handoff is a fact about the account being left; in the next account it
names nothing, or — on a business holding both — something that exists and must
not be shown, which is the plan's rollback trigger 3.

## 4. `null` stopped meaning "all accounts"

`buildEffectiveDashboardEnvelope` filled `selectedAccountIds` with **every**
assigned account whenever no single one resolved. "The operator has not chosen"
and "the operator chose all of these" were therefore the same value — D6's
"null: seçilmedi; asla tüm hesaplar değil", and the plan's §17 prohibition 11.

`selectedAccountIds` is now empty when nothing is selected, and the option list
moved to a new `assignedAccountIds` field, which describes what **may** be
chosen rather than what was. `mode: "portfolio"` still names the situation, so a
reader can require a selection instead of quietly summing accounts nobody asked
about.

## 5. Two fixes found on the way

**The rollback flag was a constant.** `app/app/layout.tsx` wrote
`zeroBaseEnabled: true` literally, so the envelope reported the canonical UI as
enabled whatever `ZERO_BASE_UI_MODE` said — including `off`, which is the
rollback lever. Anything reading that field for a rollback decision was reading a
constant. Both layouts now compute it. (`/c/**` 404s when it is false, so `true`
was at least provable there; `/app/**` had nothing gating it, which is precisely
why it had to be read.)

**Mounting a legacy page wiped the workspace switcher.**
`LegacyInteriorBridge` called `setWorkspaceSnapshot` with a one-element array —
and that action means "this is the complete list", so it **replaced** the
store's memberships. Opening any legacy interior page (Integrations, for one)
emptied the switcher to a single entry and the operator watched their other
workspaces disappear until the next bootstrap put them back. A new
`upsertWorkspaceBusiness` action adds or updates one membership without touching
the rest, replaces rather than merges when the owner differs (tenant isolation),
and deliberately does **not** set `workspaceResolved` — one business is not proof
the list was read, and claiming it would suppress the bootstrap that would
actually read it.

## 6. `providerAccountId` is the single canonical parameter

`lib/meta/provider-account-param.ts` makes `providerAccountId` canonical and
`accountId` a **read-only deprecated alias**, logged on every read so the tail is
observable and the alias can eventually go. When both appear the canonical one
wins and the alias is ignored rather than compared: two different ids in one URL
is a caller bug, and picking the "more specific" one would be guessing at an
intent nobody stated. The deprecation log carries no tenant identifier — it is a
counter, not an audit record.

Wired into `app/api/meta/campaigns/route.ts`, the one Meta route still reading
the alias.

## 7. Acceptance

| Plan acceptance item | Result | Evidence class |
|---|---|---|
| 0/1/N × surface × role matrix | **PARTIAL** — 0/1/N proven for the resolver (8 cases) and the picker (6 cases); the role dimension is WP7/T7 | VERIFIED-STATIC |
| `account_required` is escapable by selecting | **PASS** — typed refusal plus a picker on every provider surface | VERIFIED-STATIC |
| No cross-account data after a switch | **PASS** — allowlist proven to drop 12 named parameters and anything unlisted | VERIFIED-STATIC |
| `ZERO_BASE_UI_MODE` off / allowlist / on across `/c` and `/app` | **PARTIAL** — the envelope now reports the real value in both layouts; whether `off` actually withdraws every `/app` surface is a runtime question and remains **UNKNOWN** | INFERENCE |

Item 8 (business/account/window in cache keys) is deliberately **not** claimed
here: it belongs with the per-surface query work in WP9–WP10, where the query
keys live, and claiming it now would be claiming a sweep that has not been done.

## 8. Gate results

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS** |
| lint | `npx eslint .` | **PASS** |
| unit + integration | `npx vitest run` | **PASS** — 12 514 passed, 0 failed (WP3: 12 478; +36) |

New coverage: `provider-account-param.test.ts` (10),
`provider-scope-refusal.test.ts` (8), `account-scope-url.test.ts` (6),
`account-scope-control.test.tsx` (6), `workspace-membership-merge.test.ts` (5),
plus one new case in the legacy-bridge suite.

## 9. Rollback

The picker and the context bar have separate gates, as the plan asks:

- removing `<AccountScopeControl />` from the topbar withdraws the picker while
  every scope rule stays;
- `resolveProviderAccountId` keeps its old signature, so nothing had to change
  to adopt the typed resolver and nothing has to change to abandon it;
- the envelope, store, layout and param changes are independent hunks.

No schema, migration, provider state or deployed configuration is touched.

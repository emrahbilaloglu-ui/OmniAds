# WP10 / WP11 — Creative Studio, Shares and Briefs

Work packages: WP10 and WP11 of
`docs/meta-market-ready-master-plan-2026-08-22.md`
Depends on: WP0–WP9
Date: 2026-08-22

Three contract mismatches the plan names — §5.1 findings 15, 16 and 17 — all in
the mounted Creative Studio sub-surfaces. Each was a surface confidently
rendering something the server had never sent.

## 1. Finding 15 — the Shares ledger was permanently empty

`/api/creatives/share` answers `{ grants, capability }`. The client read
`data?.shares` — **a key the endpoint has never sent** — so `data?.shares ?? []`
resolved to an empty array on every account, and the ledger rendered as
"no shares" over a payload that had the rows in it all along.

That is a proven-empty claim produced by a typo-level contract mismatch, and it
is the worst kind: nothing errored, nothing logged, and the screen looked
correct.

**Fixed:** the client reads `grants`.

## 2. The same read had a second defect

`capability.canReadLedger === false` is how the endpoint says "the share
table's migration is pending" — and it answers **200** with `grants: []` when it
does. The client rendered that as an empty ledger, telling the operator they had
never shared anything. That is a claim about their own history, made from a
failed read, and it is exactly D8.

**Fixed:** an unreadable ledger produces an `unavailable` surface state carrying
the server's own message, not a list of zero.

## 3. Finding 16 — a create control that could never succeed

The mint form on the Shares ledger collects a title, an audience and an expiry.
It sends `creatives: []`. The server's `isValidPayload` requires
`obj.creatives.length > 0`.

So **every** create issued from this screen was a guaranteed 400, delivered
after the operator had filled in the whole form. Creative selection happens in
the Creative Studio share flow, which this screen has no access to.

**Fixed:** the control is `disabled-with-reason` and names where selection
happens, rather than being offered and then rejected. The `create` function is
kept, so the path is one prop away once this screen has a selection to send.

### 3.1 And the dialog no longer opens itself

`initialOpen` defaulted to `true`, so arriving at the Shares ledger put a
half-filled mint form in front of the operator — when the reason to open this
screen is almost always to check, rotate or revoke a link that already exists.
It defaults **closed**; a caller that wants it open (a reference artboard, a
resumed draft) says so. WP11 item 5.

## 4. Finding 17 — every brief reported that it had no lineage

`ServedBrief` declared `title`, `sourceCreativeId` and `sourceAccountId`.
`MetaCreativeBrief` — what the endpoint actually serves — has **none of them**.
It carries `providerAccountId`, a `sourceDecision` object holding `creativeId`,
and a `content` object holding keep/change/next.

Two consequences, both silent:

- every row rendered an **undefined title**;
- the lineage check compared two fields that are never present, so **every**
  brief reported *"This brief does not record the creative it was derived
  from"* — about briefs whose creative id was sitting in `sourceDecision`.

**Fixed:** the adapter reads `sourceDecision.creativeId` and
`providerAccountId`, keeping the flat spellings as optional fallbacks so an
older payload still parses rather than throwing.

### 4.1 A title from a field the server sends

There is no title field, so one had to be chosen rather than invented. The
decision's **published label** is what names a brief to an operator — it is the
verdict the brief was written about — with the raw label as fallback.

When neither is served the row reads **"Untitled brief"**. The **id is not used
as a name**: an id is an identifier, and printing one where a name goes is how a
UUID ends up looking like a title. `does not use the id as a name when no label
was served` pins that.

## 5. Changes

| File | Change |
|---|---|
| `components/zero-base/creative/studio-clients.tsx` | reads `grants`; degrades on `canReadLedger: false`; refuses minting |
| `components/zero-base/creative/studio-views.tsx` | `initialOpen` defaults false; create refused with a reason |
| `lib/zero-base/creative/studio-adapters.ts` | `ServedBrief` matches the served contract; lineage and title read from it |
| `lib/zero-base/copy.ts` | the create-elsewhere sentence, EN + TR |
| three test files | updated to the new defaults, with the reason recorded |

## 6. Acceptance

| Plan item | Result | Evidence class |
|---|---|---|
| Shares client reads `grants` | **PASS** | VERIFIED-STATIC — `lists the grants the endpoint actually sends` |
| capability reaches the surface; `canRead: false` degrades | **PASS** | `shows an unreadable ledger as unavailable, not as no shares` |
| create only with a real creative selection and a valid audience | **PASS** | refused at the control; `does not offer a create it cannot complete` |
| dialog defaults closed | **PASS** | same test |
| mint / list / rotate / revoke / delete all work | **PARTIAL** — list, rotate and revoke are wired and unit-covered; **mint is deliberately refused here** and lives in the Creative Studio share flow | VERIFIED-STATIC |
| `MetaCreativeBrief` fields mapped; `sourceDecision.creativeId` and `providerAccountId` preserved; title from a real field; keep/change/next preserved; no synthetic lineage | **PASS** | 4 adapter cases |
| Public Share privacy, CSV, rotate, revoke, rate limits | **NOT RE-AUDITED.** That flow was rebuilt and verified on 2026-08-21 (`854bbaaca`, recorded in `project_creative_studio_share_redesign_2026-08-21`) and nothing in this pass touches it. Re-verifying it needs a live share and a browser | UNKNOWN |
| WP10's five-tab account/window/state matrix | **NOT DONE.** The five tabs share one mounted body (`CreativeStudioExact`) whose per-tab behaviour needs a rendered comparison; that belongs with WP16's mounted visual gate | UNKNOWN |

## 7. Gate results

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS** |
| lint | `npx eslint .` | **PASS** |
| unit + integration | `npx vitest run` | **PASS** — 12 580 passed, 0 failed (WP9: 12 575; +5 net, 8 new cases replacing 3 obsolete) |

## 8. Rollback

Per surface. Each of the three fixes is an independent hunk, and the adapter
keeps the legacy field spellings, so reverting the client alone cannot leave the
adapter unable to read an old payload.

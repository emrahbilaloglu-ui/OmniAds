# WP-27A — local compatibility implementation

**READY FOR AUTHORIZED G12 — LOCAL ONLY.**

Nothing here is deployed, enabled anywhere, or observed in live traffic. Every
result below was produced on this machine, against this tree. G12 remains a
separately authorized deployment operation that this work package cannot and
does not perform.

| | |
|---|---|
| Base accepted at | `a9f598dae534` |
| Last implementation commit | `fb60061a7` — the last commit that changes shipped code |
| Documentation commits | this report and `EXECUTION_LEDGER.md` land after it; `git log --oneline fb60061a7..HEAD` shows they touch `docs/` only |
| Master plan | `ADSECUTE_ZERO_BASE_APPLICATION_IMPLEMENTATION_MASTER_PLAN_2026-08-10.md`, SHA-256 `79b4b4f88b5b89ca06dd52cfaff28c8b21e17d0cde58902fed10594d307ab613` (re-verified) |
| Design archive | `0695ae452469ba3efe2615efe3ffd30fcdb88f5847db53d569042fb864c09b9d` |
| Evidence set | `playwright/artifacts/zero-base/d8bcf0adc4/wp27a-final` (92 frames) |
| Render fingerprint | `f3be4a4e30569697ec5069ecaa74f2d96f2ddf52e92225066d5beffbcbca6193` |
| Original repo | `/Users/harmelek/Adsecute` untouched at `c46d91c2ac94` |

## Owner amendment, recorded

On 2026-08-12 the owner decided that **G9 manual assistive-technology evidence
is no longer a prerequisite for WP-27A**, and that G9 stays documented as
unverified and non-blocking for local compatibility implementation.

That decision supersedes the WP-27A precondition only. It does not close an
accessibility defect, does not authorize a deployment, and does not make G9
green. `docs/zero-base-design/v3/G9_MANUAL_AT_EVIDENCE.md` remains committed
**empty**, and nothing in this package fabricates a screen-reader result. The
historical record of G9 blocking earlier passes is left exactly as written; this
is an amendment, not a rewrite.

## The commits

A report cannot name the commit that contains it, so this table names the
implementation commits and states plainly that the documentation follows them.
Nothing after `fb60061a7` changes shipped code.

| Commit | What it does |
|---|---|
| `8333fec19` | The compatibility layer: decision module, server page wrapper, observability, `/settings` chooser, 46 shims, 46 preserved legacy bodies, 46-path test suite |
| `f000e0a08` | Puts the compatibility tests inside `test:zero-base:release`; adds the flag-on preview commands |
| `d8bcf0adc` | Recaptures the 92-frame evidence for the changed render tree |
| `fb60061a7` | Routes the chooser's copy through the EN/TR catalogue, as the locale gate demanded |
| *(correction, below)* | Makes the production-owner coverage deterministic under the full aggregate |

## Correction after the first phase-boundary review

The first review reproduced a **release-blocking failure I had not seen**:
`npm run test:zero-base:release` exited 1 because
`every unique path has a shim and a preserved legacy body on disk` timed out at
15000ms under the full 832-file Vitest run. My own runs passed, which made it a
timing flake rather than a non-issue — the worse kind of green.

Measured cause, not guessed: that assertion imported all 46 shims **and** their
46 legacy bodies sequentially, cold. These are real Next pages, so each import
pulls in a whole legacy composition. It cost **2741ms on an idle machine**,
while every test after it ran in 1–30ms on the warm graph. The entire cold cost
sat inside whichever assertion happened to run first, and under a full suite —
where workers compete for CPU — it exceeded the per-test budget.

Fixed by removing the redundancy rather than by raising a number:

- **Loaded once.** A module-level cache replaced ~12 tests × 46 routes of
  repeated dynamic imports.
- **Warmed in setup, bounded parallel.** All 46 load in `beforeAll` with a
  concurrency of 8. Setup is where setup cost belongs, and no assertion can now
  pass or fail because of it.
- **The disk assertion asks the disk.** "Is there a shim and a preserved body"
  is a question about files; it uses `existsSync` and evaluates nothing. It went
  from 2741ms to **1ms**.
- **Coverage got stronger, not weaker.** The removed import-based check split
  into three: files exist; every shim delegates to `compatibilityPage` naming
  its own route; and every warmed module is a callable server page over its
  body. 46 tests became **48**.

The one raised budget in the file is `beforeAll`'s 60s, and it is justified by
measurement: warming now costs ~1.3s idle, so 60s leaves roughly 45× headroom
for a contended worker. It guards setup, never an assertion.

Two smaller corrections from the same review: the duplicated inline
`params`/`searchParams` construction is now one `pageProps()` helper used
everywhere, and the four unused `eslint-disable no-fallthrough` directives in
`compatibility-page.tsx` are gone — `redirect()` and `notFound()` are typed
`never`, so nothing could fall through and the suppressions said otherwise.

## Denominators, read from the registry rather than typed

```
leaves                    74
changed mapping records   47
unique changed paths      46
alias mappings            20   (unchanged URLs, no shim, asserted to have none)
compatibility targets     46   ops 16 · business 28 · account 1 · split 1
```

47 records over 46 paths because `/settings` is the one split
(`/me/account-security` **and** `/c/[businessId]/manage/business`). The test
asserts these numbers against `CHANGED_MAPPINGS` and `UNIQUE_CHANGED_PATHS`, so
a mapping added to the registry without a shim fails rather than shrinking the
run.

## How it is built

**`lib/zero-base/compatibility.ts`** — the decision, as data. The table is
derived from the route registry; scope comes from the canonical URL (`/ops/**`
staff, `/me/**` account, `/c/[businessId]/**` business, two destinations
split), never from a hand-kept second list.

**`lib/zero-base/compatibility-page.tsx`** — the server page all 46 shims are.
Each shim is an import, a route name and an export.

**`lib/zero-base/compatibility-observability.ts`** — bounded counting.

**`components/zero-base/compatibility/settings-chooser.tsx`** — the split.

### Why the legacy bodies moved

Fifteen canonical `/ops/**` pages mounted the legacy `/admin/**` page module
directly — that is how the migration avoided duplicating operational logic. Had
`app/admin/x/page.tsx` become a shim in place, `/ops/x` would have imported the
shim, the shim would have redirected to `/ops/x`, and the two would have
bounced forever. **This was a real loop, found by building it.**

Each legacy body is therefore preserved verbatim at `legacy-page.tsx`, and both
sides import that: the canonical page mounts the body, the shim decides. The
loop is removed by construction. `canonicalDestinationsThatAreLegacyPaths()`
proves the remaining property — no canonical destination is itself a legacy
path — against the table rather than in prose.

### Ordering, which is the whole safety argument

1. **`off` is answered first**, before a session is read, before the database is
   touched, before anything that can throw. That is what makes
   `ZERO_BASE_UI_MODE=off` an incident response rather than a deploy.
2. **Then the actor**: session, staff status, active business, and membership
   and role through `authorizeBusiness` — the same authorizer the canonical
   pages use, so the shim is not a softer door.
3. **Then dynamic ids.** A malformed one refuses rather than redirecting.
4. **Only then the mode.** A redirect issued earlier would answer "does this
   tenant exist" with a `Location` header.

### Two decisions worth stating plainly

**A route parameter beats the session's business.** `/admin/businesses/[businessId]`
→ `/ops/businesses/[businessId]` names the tenant a staff operator is looking
*at*, not the one they work *in*. Substituting the session's business would
have redirected an admin into their own workspace — a wrong page that looks
like it worked. Caught by the 46-path sweep.

**A path that is public today stays public.** `/select-language` is public at
the edge and `/me/language` is not, so sending an anonymous visitor to login
would have turned a working page into a login wall the cutover never intended.
The edge's own list moved to `lib/public-page-prefixes.ts` and `proxy.ts` now
imports it, so there is one authority for "what is public" rather than two.

**`forbidden` and `unavailable` render the legacy body** rather than refusing.
The shim decides presentation; when the canonical surface cannot be presented
to this actor, the honest fallback is what they already have. It grants nothing
the legacy page would have refused and removes nothing it would have allowed.
`not-found` does refuse, because it covers a revoked or foreign membership,
where rendering anything would be a cross-tenant answer.

## Proof — 46 cases, driven through the production route owners

`app/compatibility-shims.route.test.tsx` imports the real `page.tsx` Next would
run and calls it. No surrogate wrapper, no re-implemented decision, no
source-marker assertion standing in for behaviour. **46 tests, all passing.**

| Requirement | How it is proved |
|---|---|
| All 47 records, 46 unique paths | Counts asserted against the registry; every record maps to a target |
| `off` renders legacy | All 46 paths, signed in **and signed out** |
| `internal` | Staff/account redirect; **every** business path stays legacy |
| `allowlist` | Listed business redirects; unlisted stays legacy; exact matching (no prefix/suffix/case slippage); empty/absent/`,`/`,,` enable nobody; does not enable `/ops` or `/me` |
| `on` | All 45 non-split paths redirect to their canonical URL |
| One hop | No destination is a path that would redirect again |
| No loops | `canonicalDestinationsThatAreLegacyPaths()` is empty |
| Dynamic ids | `/reports/[reportId]`, `/admin/users/[userId]`, `/admin/businesses/[businessId]`, `/integrations/callback/[provider]` |
| Query preserved | Filters/cursors, OAuth `code`+`state`, repeated keys not collapsed |
| Malformed flags | `yes`, `true`, `1`, `enabled`, `""`, `" "`, `internal;on`, `on,off`, `0` all fall closed; case/whitespace tolerance asserted as deliberate |
| Authorization | Anonymous → login with `next`; non-staff cannot learn an `/ops` surface exists; revoked/inactive/foreign membership → not-found; no active business → `/select-business` |
| Public exception | `/select-language` reachable signed-out; the other paths do require an account |
| Mode changes | `on → off → on` on the same path, no restart |
| `/settings` | Renders the chooser; both destinations named with the business id resolved; falls back to legacy under `off` |
| Mechanism | No `middleware.ts` introduced; `proxy.ts` (pre-existing) routes none of the 46 paths or their destinations; no shim imports `next/navigation`, uses `permanentRedirect`, `use client` or `useRouter` |
| Observability | One bounded event per decision; never records an id, query string, destination or email; a broken observer cannot break the page; all 46 routes emit within the closed set |

### End-to-end against a real production server

Built, booted standalone, and swept — not asserted from a unit test:

```
mode=on,  anonymous, all 46 paths →  45 × 307   1 × 200 (/select-language)
mode=off, anonymous, all 46 paths →  45 × 307   1 × 200 (/select-language)
```

Zero 500s. Zero 301/308 — every redirect is temporary, so nothing a browser
caches can outlive a rollback. `/overview` returned
`307 → /login?next=%2Foverview`, carrying the destination through the login
round trip. Signed-out traffic is identical in both modes, which is correct: the
edge gate decides it, and the flag changes nothing for it.

## Rollback is tested, not narrated

`ZERO_BASE_UI_MODE=off` renders the preserved legacy body on all 46 paths, with
and without a session, and is answered before any code that could fail. The
legacy compositions, the nine placeholder pages, snapshot compatibility and the
old API contracts are all still present — nothing was deleted. Step 8 retirement
is WP-27B's, after a separately recorded operator approval.

```bash
npm run zero-base:preview:off
```

## Seeing the new design locally

The canonical UI, on, on this machine, with production untouched:

```bash
npm run zero-base:preview
```

Then open **http://127.0.0.1:3000/overview** — signed in, it lands on
`/c/<yourBusinessId>/home`. `http://127.0.0.1:3000/settings` shows the split
chooser. Any of the 46 legacy URLs will do; each moves to its canonical
destination.

This uses your own `.env.local` exactly as `npm run dev` does, and sets
`ZERO_BASE_UI_MODE=on` for that process only — it writes no file, changes no
deployed configuration, and touches no production environment.
`npm run zero-base:preview:allowlist` previews the allowlist gate;
`npm run zero-base:preview:off` shows the rollback.

## Gate results on the final tree

Exit statuses read directly, never through a pipe.

| Command | Exit | Result |
|---|---|---|
| `npm run test:zero-base:release` | **0** | 21 stages |
| `npm run test:zero-base:compatibility` | 0 | 46 + 10 tests |
| `npm run test` | 0 | **9376 passed**, 61 skipped, 63 todo |
| `npm run typecheck` | 0 | clean |
| `npm run lint` | 0 | clean |
| `npm run build` | 0 | compiled; all 46 shims are `ƒ` dynamic server routes |
| `npm run test:migrations-from-zero` | 0 | schema from zero, idempotent |
| `npm run test:selection-race-seam` | 0 | S1–S7 |
| `npm run test:zero-base:routes` | 0 | route matrix sound |
| `npm run test:zero-base:flows` | 0 | 71/71 across 13 flows |
| `npm run test:zero-base:states` | 0 | **G6 38/38** · **G7 142/142** |
| `npm run test:zero-base:fidelity` | 0 | **83/83 artboards** |
| `npm run zero-base:reconcile:frames` | 0 | **92/92, 0 substitutions** |
| provenance + fidelity mutation controls | 0 | 40 passed |
| `npm run creative:v2:safety` | 0 | archive safety gate |
| `npm run creative:decision:native-ad-frozen-acceptance` | 0 | 22 tests |
| `npm run test:cutover-runner-package` | 0 | every check |
| `bash scripts/verify-database-seams.sh` | **0** | **34 of 34 stages** |

The provenance gate refused the previous evidence set by name after
`lib/zero-base/compatibility.ts` was added and again after the chooser changed;
both were resolved by recapturing, never by loosening the check.

## Gate status

| Gate | Status |
|---|---|
| G1 contract · G2 compile · G3 data · G4 Decision safety · G5 routes | GREEN |
| G6 state truth 38/38 · G7 interaction 142/142 · G8 responsive | GREEN |
| **G9 accessibility** | **RED — manual AT evidence absent, unverified, owner-declared non-blocking for WP-27A only** |
| G10 visual 83/83 · 92/92 | GREEN |
| G11 performance | GREEN |
| G12 deployment | NOT STARTED — requires separate deployment authority |

## What was deliberately not done

No deploy, no push, no flag enabled anywhere but a local process, no production
environment or data touched, no migration run against production, no provider
called, no campaign mutated. WP-27B is not started: steps 5–9 — internal
enablement, pilot businesses, the 14-day observation window, and the step-8
retirement of duplicated legacy composition — all require deployment authority
this package does not have and did not use.

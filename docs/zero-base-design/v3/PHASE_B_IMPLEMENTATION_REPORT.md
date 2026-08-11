# Phase B Implementation Report

**Date:** 2026-08-11
**Worktree:** `/Users/harmelek/Adsecute-zero-base` · branch `codex/adsecute-zero-base-implementation`
**Started from:** `33df99879` (Phase A accepted)

**Result: PHASE B IS COMPLETE.** All seven packages, WP-04 through WP-10, meet their acceptance criteria. WP-09 and WP-10 were partial at `66dbfc3fb` and were finished by follow-up commits; the partial commits are retained in history and are not relabelled as complete. Nothing was pushed, deployed, migrated in production, or run against a remote database, and `/Users/harmelek/Adsecute` is untouched.

---

## 1 · Closing the prior blocker

The earlier stop was recorded because WP-09 and WP-10 were partial, with no technical obstruction. Both are now finished by follow-up commits on top of the partial ones.

| Was missing | Now delivered | Commit |
|---|---|---|
| login/signup/forgot/reset/invite/select-business/businesses-new/shopify-connect composition | All eight go through `AuthSurface`, which gained a canonical branch | `45276d383` |
| Five invite states | Mapped from the server's own codes, each with distinct copy and next step | `45276d383` |
| OAuth callback error | `oauthCallbackErrorFrom` + panel on the Shopify return | `45276d383` |
| `PersonalAccountMenu` in canonical shell | Confined to legacy; canonical uses `UserMenu` (profile/language/theme/logout), pinned by test | `45276d383` |
| End-to-end Flow K coverage | `components/zero-base/auth/flow-k.test.tsx`, 18 cases | `45276d383` |
| `/a/desk`, `/a/desk/clients`, `/a/desk/withheld` + view components | All three routes build and render | `45a9ff1ab` |
| 50-client scan at 1440/390 | 4 Playwright checks over the real projection and table | `45a9ff1ab` |

## 1b · Correction after acceptance review

Acceptance review found one verified defect, and it was a real one: **`45a9ff1ab` was not server-paginated, and this report said it was.**

`readAgencyDirectorySource` called `listUserBusinesses` and returned every active business; the pages handed that whole array to `ClientDirectory`, which paginated and searched it in a client `useMemo`. The browser therefore received every client's name regardless of what was drawn, and the read grew with the tenant rather than the page. The tests passed because none of them looked at what crossed the wire.

`601094543` corrects it:

| Concern | Before | After |
|---|---|---|
| Where paging happens | client `useMemo` over the full array | SQL keyset pagination, `LIMIT pageSize + 1` |
| What the browser receives | every authorized client | one bounded page, then one page per request |
| Order | JS `localeCompare`, re-sorted client-side | `lower(btrim(name))` then `id`, pinned to `C` collation; the client never re-sorts |
| Cursor | array index | opaque validated `{sortKey, businessId}`, rejected when malformed |
| Activity batch | every authorized id | served page ids only |
| Boundary | none | `contract=zero-base.v1` on the adopted `/api/agency-today`, re-authorized and rollout-re-checked per page |

The fixed collation is the load-bearing detail: if the query that produces a cursor and the query that consumes it can order differently, keyset pagination silently skips or repeats rows. The name-plus-id tie-break is what keeps identically-named clients distinguishable — an id-only cursor reorders them and a name-only cursor drops all but one.

**Proof is against real PostgreSQL**, in `scripts/ephemeral-postgres-agency-directory-seam-child.ts`, wired into `migrations-from-zero`. A mocked database would have proved the mock. With 121 clients it asserts: one bounded first page; identical order across page sizes 7, 25 and 100; no gap, duplicate or reorder; three identically-named rows all served and id-ordered; invited/pending/other-tenant rows excluded; a cursor naming another tenant cannot surface it; reviewer scoping; malformed cursors failing closed; and the allowlisted key set.

The Agency **gate** had the same problem in miniature: `app/a/layout.tsx` materialised every membership just to check there were at least two. It now uses a bounded `countAgencyClients` query, asserted in the same seam to agree exactly with the paged scan and to apply the same scope filters.

The superseded `agency-directory-server.ts` and its test are deleted rather than left beside the new path.

## 2 · Packages

| WP | State | Commits |
|---|---|---|
| **04** Tokens, fonts, no-flash theme | **complete** | `a1727c835` |
| **05** Primitives, portals, state grammar | **complete** | `dd34e444f`, `37f58cd10` |
| **06** Shell, layouts, navigation | **complete** | `13eecae3a` |
| **07** Instrumentation v2 | **complete** | `6d6cba61e`, `cc5a29050` |
| **08** Permission-aware search | **complete** | `d94e440dc` |
| **09** Auth, onboarding, account | **complete** | `7865057c1` → `45276d383` |
| **10** Agency Desk | **complete** | `15de2901c` → `45a9ff1ab` → `601094543` → `0a50fa6a8` |

## 3 · Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | **PASS — 0** |
| `npm run lint` | **PASS — 0** |
| `npm test` | **PASS — 7,984 passed · 0 failed · 771 files** |
| `npm run test:migrations-from-zero` | **PASS — exit 0** (incl. the instrumentation seam) |
| `npm run zero-base:contract:verify` | **PASS — 23/23** |
| `npm run zero-base:contracts:check` | **PASS — generated file current** |
| `npm run zero-base:fonts:verify` | **PASS** |
| Playwright `zero-base-theme-chromium` | **PASS — 20/20** |
| Production build | **PASS** |

Phase A ended at 7,714 tests; Phase B added 270, and no pre-existing test changed status.

## 4 · Responsive and theme evidence

`npm run test:zero-base:responsive` renders the **real** shell components against the **real** `app/globals.css` in Chromium, at every named width in both themes.

| Width | Light | Dark | Checks |
|---|---|---|---|
| 1440 | PASS | PASS | no page overflow · rail 232px · full context bar · theme applied |
| 1280 | PASS | PASS | as above, plus wide content scrolling inside `main` |
| 768 | PASS | PASS | rail present at the breakpoint |
| 390 | PASS | PASS | drawer replaces rail · compact context bar |
| 320 | PASS | PASS | drawer · compact bar · no horizontal scroll |

Plus **B02**: at 1280×640 the rail footer's bottom edge is inside the artboard and the nav area has a real scroll range.

**WP-10 · 50-client Agency scan**, rendered from the real projection through the real table:

| Width | Light | Dark | Checks |
|---|---|---|---|
| 1440 | PASS | PASS | all 50 rows · "Showing 50 of 50" · no page overflow · exact 4-column header · no money/ranking text · currency labelled `(configured)` |
| 390 | PASS | PASS | as above, plus the table scrolling inside `main` rather than widening the page |

**Bound, stated plainly:** this measures the shell's layout contract, not a data-populated live page. This worktree has no `.env.local` and reaches no database by design, so there is no server to render one. Overflow and clipping are CSS outcomes, which is what this checks — against the shipped stylesheet, not a copy.

## 5 · What the tests caught that reasoning did not

Eight defects surfaced from measurement rather than review:

1. **Rail was 233px, not 232.** Content-box sizing put the 1px border outside the declared width, shifting every column beside it.
2. **Rail footer sat 732px below a 640px viewport.** `min-height: 100vh` left the flex parent without a definite height, so the rail grew with its own nav list and `min-height: 0` on the scroll area did nothing. That is B02, and only a real browser could show it.
3. **Radix Popover stole focus from the combobox input**, making typing impossible. The listbox is now portalled by hand, following the APG pattern where focus stays in the input.
4. **`account_id` was an unconstrained TEXT column.** The repo's own instrumentation seam refused it, correctly — free text is where a token or a query string eventually lands.
5. **Agency's Load more disappeared at the end of the projection** instead of disabling with its reason. A control that vanishes reads as a broken page, not a finished list.
6. **A cursor of `"zzzzzzzz"` was not past the end.** Under `C` collation a non-ASCII first byte sorts above `z`, so `"ácme"` follows it. Accent placement is now asserted explicitly rather than left implicit.
7. **A search matching nothing among loaded rows rendered an empty table** with headers and no body, which says none of the three things it could mean — no clients, no matches, or keep paging. It now names which.
8. **Banning the bare word `total` also banned `totalCount`**, an honest row count the collection envelope needs. Every monetary total is already caught by its own term, so the broad ban forbade correct pagination and caught nothing extra.

## 6 · Font licensing (WP-04)

Both families are OFL, and the proof is mechanical rather than asserted. Each binary's `name` table was decompressed and its copyright string compared to the first line of the license claiming to cover it; both match exactly, and both `name[14]` fields point at the SIL OFL.

| Family | License | SHA-256 | Upstream revision |
|---|---|---|---|
| Schibsted Grotesk | `OFL-schibsted-grotesk.txt` | `3b4f3063b6ac7c1e…` | `google/fonts` `cc054e5ee906ac9b9024971b64d821aa2561c582` |
| Fragment Mono | `OFL-fragment-mono.txt` | `ef14426248ca0404…` | `google/fonts` `8db5a9256b34ffad61e53aafeecb4a612faa0080` |

Binaries came only from the hash-verified archive (`0695ae4524…`), and the production build self-hosts both at their exact hashes. No font binary was downloaded and no runtime Google Fonts request exists.

**Deviation, deliberate:** the archive ships four Schibsted "weights" that are byte-identical. The WOFF2 table directory carries `fvar`/`gvar`/`avar`/`STAT`, so it is one variable font with a `wght` axis of 400–900, and the archive's CSS pins it to four fixed instances — downloading the same 46,864 bytes up to four times. We ship it once across its real axis.

## 7 · Deviations from the plan, and why

- **Tokens are `--ledger-*`, not `--adc-*`.** The repo already ships 25 `--adc-*` variables for the legacy console shell. Sharing the prefix would make "no Ledger token escapes the canonical root" untestable. The plan-mandated `--font-adc-sans`/`--font-adc-mono` keep their names; neither collides.
- **Six dark tokens are marked DERIVED.** The design's dark table omits `accent/hover`, all three lanes, `ink/quiet` and the withheld border. They are ours and are labelled as such rather than presented as design values.
- **`lib/visual-dark-mode.test.ts` was narrowed.** It asserted a blanket absence of any theme mechanism and carried an explicit instruction to extend the matrix when a real one landed. It now asserts the guarantee that is still true — legacy has no reachable dark mode, and every dark media query must prove it is confined to the canonical root.
- **`platformOrder` only.** TikTok/Pinterest/Snapchat are removed from navigation but kept in the type and registry, because their legacy routes still reference them. Deleting the concept is WP-27's cleanup.
- **Rollout reaches client auth screens through a server-seeded provider.** Login, signup and invite are client components and cannot read the environment. The flag is read once in `app/layout.tsx` and handed down as inert data rather than exposed as `NEXT_PUBLIC_*`, which the plan forbids as a boundary even for presentation.
- **`AuthSurface` became a client component.** It is the single frame all eight auth compositions share, so it is where the canonical branch belongs; server pages still render it as a slot host. With rollout off it emits the previous markup byte-for-byte.
- **The client `LoginResponse` type gained `membershipStatus`.** The endpoint already returned it — the client type simply omitted it. Type-only; auth endpoints are unchanged.

## 8 · Preserved contracts

- Phase A safety contracts are untouched. No resolver math, decision truth or provider authority was altered; `creative:v2:safety` and the native-ad frozen acceptance still pass.
- The design package remains **NOT READY** (REQ-27, REQ-28/`M11`, REQ-41). The verifier still asserts `audit.verdict === "NOT READY"`.
- `ZERO_BASE_REPORT_SHARE_FAIL_CLOSED` remains default-false and set in no environment file.
- Instrumentation v2 is additive: one table, nullable columns, widened vocabularies with the v1 values restated in full.

## 9 · Rollback

Every package is one revert. Canonical routes do not exist with rollout off, so no rollback is needed to protect legacy:

```
git revert 0a50fa6a8 601094543 45a9ff1ab 15de2901c 45276d383 7865057c1 d94e440dc cc5a29050 6d6cba61e 13eecae3a 37f58cd10 dd34e444f a1727c835
```

Reverting only the follow-up commits (`45a9ff1ab`, `45276d383`) returns Phase B to its `66dbfc3fb` state with WP-04–WP-08 intact.

Removing the canonical CSS block from `app/globals.css` restores legacy styling exactly; the primitives and shell are unused by legacy pages.

## 10 · Remaining limitations

Recorded because they are real, and none of them is a WP-09 or WP-10 acceptance criterion:

- **Turkish copy does not render.** `getLanguageFromCookieValue` is pinned to English app-wide, so a Turkish preference is stored but nothing reads it. Both the account leaf and the public route now say so rather than presenting a working selector.
- **`sourceUpdatedAt` can be null.** It comes from `platform_overview_daily_summary`; a client with no rows in the last 30 days renders "Not recorded" rather than a fabricated timestamp.
- **The responsive evidence measures layout, not a live page.** This worktree has no `.env.local` and reaches no database by design, so the harness renders the real components against the real stylesheet. Overflow and clipping are CSS outcomes, which is what it checks.
- **Accented client names sort after ASCII ones** in the Agency directory. That is a consequence of pinning the order to the `C` collation, which is what makes the cursor safe across databases; a locale-aware collation would fold them together but could reorder between two queries and break paging. Asserted in the seam rather than left as a surprise.
- **The design package remains NOT READY** (REQ-27, REQ-28/`M11`, REQ-41), unchanged from Phase A and still asserted by the verifier.

## 11 · Next

WP-11 (Client Home) was not started, as instructed.

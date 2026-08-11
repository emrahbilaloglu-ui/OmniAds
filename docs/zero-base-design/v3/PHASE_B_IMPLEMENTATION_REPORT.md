# Phase B Implementation Report

**Date:** 2026-08-11
**Worktree:** `/Users/harmelek/Adsecute-zero-base` · branch `codex/adsecute-zero-base-implementation`
**Started from:** `33df99879` (Phase A accepted)

**Result: PHASE B IS BLOCKED.** WP-04, WP-05, WP-06, WP-07 and WP-08 are complete and meet their acceptance criteria. **WP-09 and WP-10 are partial** — the parts that are committed are whole and tested, but neither package's full scope was delivered. Nothing was pushed, deployed, migrated in production, or run against a remote database, and `/Users/harmelek/Adsecute` is untouched.

---

## 1 · Blocker

> **WP-09 and WP-10 were not completed.** WP-09 delivers canonical post-login routing and the two `/me` leaves, but not the auth/onboarding composition the package requires: `login`, `signup`, `forgot`, `reset`, `demo`, `invite`, `select-business`, `business-new` and `shopify-connect` are unmodified, the five invite states and the OAuth callback error state are unbuilt, `components/layout/PersonalAccountMenu.tsx` is unchanged, and there is no end-to-end Flow K test. WP-10 delivers the safe projection with its key-allowlist guard, but not `/a/desk`, `/a/desk/clients`, `/a/desk/withheld`, the Agency view components, or the 50-client scan at 1440/390.

**Evidence:** `app/login`, `app/signup`, `app/invite`, `app/select-business` and `components/layout/PersonalAccountMenu.tsx` carry no zero-base changes in `git diff 33df99879..HEAD --stat`; `app/a/` contains only `layout.tsx` with no `page.tsx` beneath it.

**Cause:** working context, not a technical obstruction. Each remaining piece is unblocked — WP-09's routing core and WP-10's projection, which are the parts the rest composes onto, are done and green.

## 2 · Packages

| WP | State | Commits |
|---|---|---|
| **04** Tokens, fonts, no-flash theme | **complete** | `a1727c835` |
| **05** Primitives, portals, state grammar | **complete** | `dd34e444f`, `37f58cd10` |
| **06** Shell, layouts, navigation | **complete** | `13eecae3a` |
| **07** Instrumentation v2 | **complete** | `6d6cba61e`, `cc5a29050` |
| **08** Permission-aware search | **complete** | `d94e440dc` |
| **09** Auth, onboarding, account | **partial** | `7865057c1` |
| **10** Agency Desk | **partial** | `15de2901c` |

## 3 · Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | **PASS — 0** |
| `npm run lint` | **PASS — 0** |
| `npm test` | **PASS — 7,900 passed · 0 failed · 761 files** |
| `npm run test:migrations-from-zero` | **PASS — exit 0** (incl. the instrumentation seam) |
| `npm run zero-base:contract:verify` | **PASS — 23/23** |
| `npm run zero-base:contracts:check` | **PASS — generated file current** |
| `npm run zero-base:fonts:verify` | **PASS** |
| Playwright `zero-base-theme-chromium` | **PASS — 16/16** |
| Production build | **PASS** |

Phase A ended at 7,714 tests; Phase B added 186, and no pre-existing test changed status.

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

**Bound, stated plainly:** this measures the shell's layout contract, not a data-populated live page. This worktree has no `.env.local` and reaches no database by design, so there is no server to render one. Overflow and clipping are CSS outcomes, which is what this checks — against the shipped stylesheet, not a copy.

## 5 · What the tests caught that reasoning did not

Four defects surfaced from measurement rather than review:

1. **Rail was 233px, not 232.** Content-box sizing put the 1px border outside the declared width, shifting every column beside it.
2. **Rail footer sat 732px below a 640px viewport.** `min-height: 100vh` left the flex parent without a definite height, so the rail grew with its own nav list and `min-height: 0` on the scroll area did nothing. That is B02, and only a real browser could show it.
3. **Radix Popover stole focus from the combobox input**, making typing impossible. The listbox is now portalled by hand, following the APG pattern where focus stays in the input.
4. **`account_id` was an unconstrained TEXT column.** The repo's own instrumentation seam refused it, correctly — free text is where a token or a query string eventually lands.

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

## 8 · Preserved contracts

- Phase A safety contracts are untouched. No resolver math, decision truth or provider authority was altered; `creative:v2:safety` and the native-ad frozen acceptance still pass.
- The design package remains **NOT READY** (REQ-27, REQ-28/`M11`, REQ-41). The verifier still asserts `audit.verdict === "NOT READY"`.
- `ZERO_BASE_REPORT_SHARE_FAIL_CLOSED` remains default-false and set in no environment file.
- Instrumentation v2 is additive: one table, nullable columns, widened vocabularies with the v1 values restated in full.

## 9 · Rollback

Every package is one revert. Canonical routes do not exist with rollout off, so no rollback is needed to protect legacy:

```
git revert 15de2901c 7865057c1 d94e440dc cc5a29050 6d6cba61e 13eecae3a 37f58cd10 dd34e444f a1727c835
```

Removing the canonical CSS block from `app/globals.css` restores legacy styling exactly; the primitives and shell are unused by legacy pages.

## 10 · Next

Finish WP-09's auth/onboarding composition and WP-10's three Agency routes, both of which now build on committed, tested foundations. WP-11 was not started.

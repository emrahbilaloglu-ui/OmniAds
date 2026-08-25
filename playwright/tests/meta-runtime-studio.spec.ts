/**
 * WP10, on the running server: five tabs, one scope, one window, one posture.
 *
 * Creative Studio is five surfaces sharing a shell, and every one of the ways
 * that goes wrong is invisible from a unit test:
 *
 *   - a tab that keeps the previous tab's account, so figures for account A
 *     appear under account B's name;
 *   - a tab that resolves its own window, so the caption above says one week
 *     and the table below is another;
 *   - a tab that renders five empty panels for an unscoped account, which is
 *     indistinguishable from an account that genuinely has nothing;
 *   - and the one WP10 names outright: a shadow decision presented as though
 *     somebody stands behind it.
 *
 * Each of those is a claim about a real request against a real database, so
 * each is asked here rather than described.
 */
import { expect, test, type Page, type Request } from "@playwright/test";

import { META_SURFACES } from "../../lib/meta/surface-registry";
import { openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();

/** The five tabs of the Studio, in the order the design puts them. */
const TABS = [
  "creative-studio",
  "creative-copies",
  "creative-landing-pages",
  "creative-inbox",
  "creative-audiences",
] as const;

function routeFor(surfaceId: string, businessId: string): string {
  const surface = META_SURFACES.find((item) => item.surfaceId === surfaceId);
  if (!surface) throw new Error(`no surface ${surfaceId}`);
  return surface.canonicalRoute.replace("[businessId]", businessId);
}

/** The closed §9 vocabulary. A surface answering outside it answers nothing. */
const READ_STATES = [
  "loading",
  "refreshing-with-stale",
  "success",
  "empty-proven",
  "partial",
  "degraded",
  "refused",
];

async function surfaceState(page: Page): Promise<{
  state: string | null;
  code: string | null;
  account: string | null;
} | null> {
  return page.evaluate(() => {
    const region = document.querySelector<HTMLElement>("[data-meta-surface-state]");
    if (!region) return null;
    return {
      state: region.dataset.readState ?? null,
      code: region.dataset.failureCode ?? null,
      account: region.dataset.providerAccount ?? null,
    };
  });
}

/** Every account id an API request named while `run` executed. */
async function accountsRequestedDuring(
  page: Page,
  run: () => Promise<void>,
): Promise<Set<string>> {
  const seen = new Set<string>();
  const listener = (request: Request) => {
    if (!request.url().includes("/api/")) return;
    const account = new URL(request.url()).searchParams.get("providerAccountId");
    if (account) seen.add(account);
  };
  page.on("request", listener);
  try {
    await run();
  } finally {
    page.off("request", listener);
  }
  return seen;
}

test.describe("the five tabs × the three account postures", () => {
  const POSTURES: { name: string; businessId: string; account?: string }[] = [
    { name: "zero accounts", businessId: handle.businesses.zeroAccounts },
    { name: "one account", businessId: handle.businesses.oneAccount },
    { name: "many, none chosen", businessId: handle.businesses.manyAccounts },
    {
      name: "many, one chosen",
      businessId: handle.businesses.manyAccounts,
      account: handle.accounts.manyA,
    },
  ];

  for (const tab of TABS) {
    for (const posture of POSTURES) {
      test(`${tab} — ${posture.name}`, async ({ page }) => {
        const query = posture.account ? `?providerAccountId=${posture.account}` : "";
        await openSurface(page, handle, `${routeFor(tab, posture.businessId)}${query}`);

        const observed = await surfaceState(page);
        expect(observed, `${tab} rendered no §9 region`).not.toBeNull();
        expect(READ_STATES, `${tab} answered outside the closed vocabulary`).toContain(
          observed!.state,
        );

        /*
         * D6, per cell. Zero accounts and an unchosen selection are REFUSALS —
         * five empty panels would be indistinguishable from an account that
         * genuinely has nothing — and a refusal must carry the reason that
         * tells the operator which of the two it is.
         */
        if (!posture.account && posture.businessId !== handle.businesses.oneAccount) {
          expect(observed!.state, `${tab} served an unscoped account`).toBe("refused");
          expect(observed!.code, `${tab} refused without saying why`).toBeTruthy();
          expect(observed!.account).toBeNull();
        } else {
          // A resolved scope is the account that was asked for, never another.
          const expected = posture.account ?? handle.accounts.one;
          if (observed!.state !== "refused") {
            expect(observed!.account, `${tab} served a different account`).toBe(expected);
          }
        }

        // A code exists exactly when the state is one that has a reason.
        const needsReason = ["degraded", "refused", "partial"].includes(
          observed!.state ?? "",
        );
        expect(Boolean(observed!.code), `${tab}: ${observed!.state}`).toBe(needsReason);
      });
    }
  }
});

test.describe("the window reaches every tab the same way", () => {
  for (const tab of TABS) {
    test(`${tab} carries the stated window into its requests`, async ({ page }) => {
      const startDate = "2026-04-06";
      const endDate = "2026-04-19";

      const windows: string[] = [];
      const listener = (request: Request) => {
        if (!request.url().includes("/api/")) return;
        const params = new URL(request.url()).searchParams;
        const start = params.get("startDate") ?? params.get("start") ?? params.get("from");
        const end = params.get("endDate") ?? params.get("end") ?? params.get("to");
        if (start && end) windows.push(`${start}..${end}`);
      };
      page.on("request", listener);
      try {
        await openSurface(
          page,
          handle,
          `${routeFor(tab, handle.businesses.oneAccount)}?window=custom&startDate=${startDate}&endDate=${endDate}&start=${startDate}&end=${endDate}`,
        );
      } finally {
        page.off("request", listener);
      }

      /*
       * Not every tab reads a window — Audiences is current-state — so an empty
       * list is a legitimate answer. What is never legitimate is a tab that
       * reads SOME OTHER window than the one the URL states, which is how the
       * caption above the table and the rows inside it came apart.
       */
      const wrong = windows.filter((window) => window !== `${startDate}..${endDate}`);
      expect(wrong, `${tab} measured a window the URL did not state`).toEqual([]);
    });
  }
});

test("switching tabs does not carry the previous tab's account with it", async ({
  page,
}) => {
  /**
   * The leak WP10 names, walked in the sequence that produces it.
   *
   * Cross-account cache keys were business-scoped only, so a tab switch served
   * the previous account's rows under the new account's name. The many-account
   * business is the one that can express this at all: two assigned accounts,
   * and a switch between them across four tabs.
   */
  const a = handle.accounts.manyA;
  const b = handle.accounts.manyB;

  for (const tab of TABS) {
    await openSurface(
      page,
      handle,
      `${routeFor(tab, handle.businesses.manyAccounts)}?providerAccountId=${a}`,
    );
    expect((await surfaceState(page))?.account, `${tab} did not scope to A`).toBe(a);

    const requested = await accountsRequestedDuring(page, async () => {
      await openSurface(
        page,
        handle,
        `${routeFor(tab, handle.businesses.manyAccounts)}?providerAccountId=${b}`,
      );
    });

    expect((await surfaceState(page))?.account, `${tab} did not move to B`).toBe(b);
    expect(
      [...requested].filter((account) => account === a),
      `${tab} kept asking for the previous account after the switch`,
    ).toEqual([]);
  }
});

test("switching tabs does not carry the previous tab's scope refusal with it", async ({
  page,
}) => {
  // The inverse leak: an unscoped tab followed by a scoped one must serve, and
  // a scoped tab followed by an unscoped one must refuse. A cached refusal is
  // as wrong as cached rows.
  await openSurface(page, handle, routeFor("creative-copies", handle.businesses.manyAccounts));
  expect((await surfaceState(page))?.state).toBe("refused");

  await openSurface(
    page,
    handle,
    `${routeFor("creative-inbox", handle.businesses.manyAccounts)}?providerAccountId=${handle.accounts.manyB}`,
  );
  const scoped = await surfaceState(page);
  expect(scoped?.state).not.toBe("refused");
  expect(scoped?.account).toBe(handle.accounts.manyB);

  await openSurface(
    page,
    handle,
    routeFor("creative-audiences", handle.businesses.manyAccounts),
  );
  expect((await surfaceState(page))?.state).toBe("refused");
});

test.describe("WP10 — the engine posture is stated, and shadow is never authority", () => {
  test("the Studio hub names which of the five postures it is in", async ({ page }) => {
    /**
     * The five postures and their operator sentences have existed since WP10
     * was written, and nothing mounted called them: the module was reachable
     * only from its own test. A Studio in shadow mode and a Studio serving live
     * decisions looked identical, which is precisely what
     * "shadow decision authority gibi gösterilmez" forbids.
     */
    await openSurface(
      page,
      handle,
      routeFor("creative-studio", handle.businesses.oneAccount),
    );

    const notice = page.locator("[data-engine-posture]").first();
    await expect(notice).toHaveCount(1);
    const posture = await notice.getAttribute("data-engine-posture");
    expect(
      ["unavailable", "disabled", "shadow_only", "hidden", "serving"],
      "the surface named a posture outside the five",
    ).toContain(posture);
  });

  test("a non-serving posture is explained, not merely labelled", async ({ page }) => {
    await openSurface(
      page,
      handle,
      routeFor("creative-studio", handle.businesses.oneAccount),
    );
    const notice = page.locator("[data-engine-posture]").first();
    const posture = await notice.getAttribute("data-engine-posture");

    if (posture === "serving") {
      // The quiet, correct state: it carries the authority marker and says
      // nothing, because a banner announcing that everything is normal teaches
      // people to stop reading banners.
      await expect(notice).toHaveAttribute("data-decisions-are-authority", "");
      return;
    }

    // Everything else changes what the operator may believe, and says so.
    expect(await notice.getAttribute("data-decisions-are-authority")).toBeNull();
    const text = (await notice.innerText()).replace(/\s+/g, " ");
    expect(text.length, "a posture with no explanation is a posture nobody trusts")
      .toBeGreaterThan(40);
  });
});

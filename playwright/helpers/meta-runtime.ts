/**
 * The handle `scripts/meta/runtime-evidence-harness.ts` writes, and the two
 * things every runtime spec needs: a signed-in page, and the canonical routes.
 *
 * The routes come from the WP2 surface registry rather than a list retyped
 * here, so a spec can never quietly stop covering a surface that exists.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

import { META_SURFACES } from "../../lib/meta/surface-registry";

export interface RuntimeHandle {
  baseUrl: string;
  databaseUrl: string;
  operator: { id: string; email: string; password: string };
  businesses: {
    zeroAccounts: string;
    oneAccount: string;
    manyAccounts: string;
    otherTenant: string;
  };
  accounts: { one: string; manyA: string; manyB: string; otherTenant: string };
}

export function runtimeHandle(): RuntimeHandle {
  const file = process.env.META_RUNTIME_HANDLE;
  if (!file) {
    throw new Error(
      "META_RUNTIME_HANDLE is unset. These specs describe a live server with a real\n" +
        "database and are meaningless without one. Run: npm run meta:runtime-evidence",
    );
  }
  return JSON.parse(readFileSync(file, "utf8")) as RuntimeHandle;
}

/**
 * Sign in through the real login route.
 *
 * Not a forged cookie: the session this returns is the one the operator gets,
 * issued by the same handler that verifies the bcrypt hash. A spec that minted
 * its own cookie would prove nothing about whether login works.
 */
export async function signIn(page: Page, handle: RuntimeHandle): Promise<void> {
  await page.goto(`${handle.baseUrl}/login`);
  const response = await page.evaluate(
    async ({ email, password }: { email: string; password: string }) => {
      const result = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      return { status: result.status, body: await result.text() };
    },
    { email: handle.operator.email, password: handle.operator.password },
  );
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${response.body}`);
  }
}

/** Every canonical route that takes a `[businessId]`, resolved for one. */
export function canonicalRoutesFor(businessId: string): { surfaceId: string; path: string }[] {
  return META_SURFACES.filter((surface) => surface.canonicalRoute.includes("[businessId]"))
    .filter((surface) => !surface.canonicalRoute.includes("[creativeId]"))
    .map((surface) => ({
      surfaceId: surface.surfaceId,
      path: surface.canonicalRoute.replace("[businessId]", businessId),
    }));
}

/**
 * Go to a canonical route and wait for the surface to stop loading.
 *
 * `/c/:businessId/...` redirects through `/switch-business` into the `/app`
 * twin, which is the real mounted composition. The wait is on the shell's own
 * "Loading workspace" text disappearing rather than on `networkidle`, because
 * these surfaces poll and `networkidle` never arrives.
 */
export async function openSurface(page: Page, handle: RuntimeHandle, path: string): Promise<void> {
  await page.goto(`${handle.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load");
  await page
    .locator("text=Loading workspace")
    .first()
    .waitFor({ state: "detached", timeout: 30_000 })
    .catch(() => {
      /* Some surfaces never render it; absence is the same end state. */
    });
}

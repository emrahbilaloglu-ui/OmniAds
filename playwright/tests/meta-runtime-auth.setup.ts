/**
 * One sign-in for the whole runtime-evidence run.
 *
 * Every spec used to log in for itself, and the login route throttles by client
 * address — correctly, and it caught this: at the twentieth test the route
 * answered `429 rate_limited` and the a11y failures that followed were the
 * throttle, not the page. Signing in once and reusing the session is what an
 * operator does anyway.
 *
 * The 429 is worth keeping as evidence rather than only as an obstacle, so
 * `meta-runtime-security.spec.ts` provokes it deliberately.
 */
import path from "node:path";
import { expect, test as setup } from "@playwright/test";

import { runtimeHandle, signIn } from "../helpers/meta-runtime";

export const RUNTIME_AUTH_FILE = path.join(
  process.cwd(),
  "playwright/.runtime/meta-runtime-operator.json",
);

setup("sign the runtime operator in once", async ({ page }) => {
  const handle = runtimeHandle();
  await signIn(page, handle);

  const me = await page.evaluate(async () => {
    const response = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });
    return { status: response.status, body: await response.text() };
  });
  expect(me.status, me.body).toBe(200);
  expect(me.body).toContain(handle.businesses.oneAccount);

  await page.context().storageState({ path: RUNTIME_AUTH_FILE });
});

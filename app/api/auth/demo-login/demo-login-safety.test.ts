import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `/api/auth/demo-login` is public, unauthenticated and reachable by GET — it is
 * allow-listed in proxy.ts and linked from the landing page.
 *
 * It used to run `DELETE FROM sessions WHERE user_id = <demo user>` before doing
 * anything else, so any stranger could sign the demo account out of every device
 * by loading a URL, repeatedly. That is an unauthenticated destructive write to
 * production, and the stated reason for it — token_hash collisions — cannot
 * happen, because createSession draws a fresh random token each time.
 *
 * Asserted against the source because the defect IS the statement: a runtime
 * test that mocked the database would assert the mock, and the previous
 * behaviour was a single line that no existing test exercised at all.
 */
const source = fs.readFileSync(
  path.join(process.cwd(), "app/api/auth/demo-login/route.ts"),
  "utf8",
);

describe("demo-login destructive write", () => {
  it("never deletes sessions unconditionally", () => {
    const deletes = Array.from(source.matchAll(/DELETE\s+FROM\s+sessions[^`]*/gi)).map((m) =>
      m[0].replace(/\s+/g, " ").trim(),
    );
    expect(deletes.length, "expected exactly one session delete to reason about").toBe(1);
    expect(
      deletes[0],
      "an unauthenticated public endpoint must not delete a user's live sessions",
    ).toMatch(/expires_at/);
  });

  it("scopes any delete to the demo user, never to all sessions", () => {
    const deletes = Array.from(source.matchAll(/DELETE\s+FROM\s+sessions[^`]*/gi)).map((m) => m[0]);
    for (const statement of deletes) {
      expect(statement).toMatch(/user_id/);
    }
  });

  it("still mints the demo session, so the linked demo keeps working", () => {
    expect(source).toMatch(/createSession/);
    expect(source).toMatch(/attachSessionCookie/);
  });
});

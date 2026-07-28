import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENERIC_SIGN_IN_ERROR,
  GOOGLE_SIGN_IN_ERRORS,
  resolveSignInError,
} from "./auth-google-errors";

describe("resolveSignInError", () => {
  it("passes through the messages the callback actually emits", () => {
    for (const message of GOOGLE_SIGN_IN_ERRORS) {
      expect(resolveSignInError(message)).toBe(message);
    }
  });

  it("replaces anything else, so /login cannot be used as a phishing panel", () => {
    expect(resolveSignInError("Your account is locked. Call +1-555-0100.")).toBe(
      GENERIC_SIGN_IN_ERROR,
    );
    expect(resolveSignInError("<b>urgent</b>")).toBe(GENERIC_SIGN_IN_ERROR);
  });

  it("renders nothing when there is no error", () => {
    expect(resolveSignInError(null)).toBeNull();
    expect(resolveSignInError("")).toBeNull();
  });

  it("stays in step with the callback, so a new message cannot silently degrade", () => {
    // The allowlist lives apart from the route that emits these strings, so the
    // two can drift. This reads the route and requires every literal it can
    // redirect with to be covered.
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/api/oauth/sign-with-google/callback/route.ts"),
      "utf8",
    );
    const emitted = Array.from(source.matchAll(/errorRedirect\("([^"]+)"\)/g)).map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(0);
    for (const message of emitted) {
      expect(GOOGLE_SIGN_IN_ERRORS, `callback emits "${message}" but the allowlist omits it`).toContain(
        message,
      );
    }
  });
});

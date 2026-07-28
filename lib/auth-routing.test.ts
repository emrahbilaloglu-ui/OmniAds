import { describe, expect, it } from "vitest";
import { resolvePostLoginDestination, sanitizeNextPath } from "./auth-routing";

/**
 * This helper decides where a freshly authenticated user lands, and its result
 * is passed to `new URL(value, origin)` on a response that already carries the
 * session cookie. Anything that escapes the site here is a POST-authentication
 * open redirect: the victim is signed in, then handed to the attacker's page
 * with the referer intact.
 *
 * The guard used to be `!startsWith("/") || startsWith("//")`, which is exactly
 * the shape that looks right and is not.
 */
describe("sanitizeNextPath", () => {
  it("keeps ordinary in-app destinations", () => {
    expect(sanitizeNextPath("/overview")).toBe("/overview");
    expect(sanitizeNextPath("/settings?tab=billing")).toBe("/settings?tab=billing");
    expect(sanitizeNextPath("/platforms/meta/creatives#top")).toBe("/platforms/meta/creatives#top");
  });

  it("rejects a backslash protocol-relative URL, which the old guard allowed", () => {
    // The WHATWG parser treats "\" as "/" for special schemes, so this passes a
    // startsWith("//") check and still resolves to https://evil.com/.
    expect(new URL("/\\evil.com", "https://app.example").origin).toBe("https://evil.com");
    expect(sanitizeNextPath("/\\evil.com")).toBeNull();
    expect(sanitizeNextPath("/\\/evil.com")).toBeNull();
    expect(sanitizeNextPath("/\\\\evil.com")).toBeNull();
  });

  it("rejects the forms the old guard did catch", () => {
    expect(sanitizeNextPath("//evil.com")).toBeNull();
    expect(sanitizeNextPath("https://evil.com")).toBeNull();
    expect(sanitizeNextPath("http://evil.com")).toBeNull();
    expect(sanitizeNextPath("javascript:alert(1)")).toBeNull();
    expect(sanitizeNextPath("evil.com")).toBeNull();
  });

  it("rejects control characters, which the parser strips before deciding", () => {
    expect(sanitizeNextPath("/\t/evil.com")).toBeNull();
    expect(sanitizeNextPath("/\n/evil.com")).toBeNull();
    expect(sanitizeNextPath("\t//evil.com")).toBeNull();
  });

  it("rejects empty and missing values", () => {
    expect(sanitizeNextPath(null)).toBeNull();
    expect(sanitizeNextPath(undefined)).toBeNull();
    expect(sanitizeNextPath("")).toBeNull();
  });

  it("never returns a value whose resolved origin differs from the site", () => {
    // The property that matters, stated directly rather than as a pattern list:
    // whatever survives must resolve back to the same origin.
    const base = "https://app.example";
    const candidates = [
      "/overview",
      "/\\evil.com",
      "//evil.com",
      "/\\\\evil.com",
      "https://evil.com",
      "/a/b?c=d#e",
      "/\t/evil.com",
    ];
    for (const candidate of candidates) {
      const safe = sanitizeNextPath(candidate);
      if (safe !== null) {
        expect(new URL(safe, base).origin, `${candidate} escaped the origin`).toBe(base);
      }
    }
  });
});

describe("resolvePostLoginDestination", () => {
  const businesses = [{ id: "b1" as const }];

  it("honours a safe next path", () => {
    expect(
      resolvePostLoginDestination({ businesses, activeBusinessId: "b1", nextPath: "/reports" }),
    ).toBe("/reports");
  });

  it("falls back to the computed destination when next is hostile", () => {
    expect(
      resolvePostLoginDestination({ businesses, activeBusinessId: "b1", nextPath: "/\\evil.com" }),
    ).toBe("/overview");
    expect(
      resolvePostLoginDestination({ businesses, activeBusinessId: "b1", nextPath: "//evil.com" }),
    ).toBe("/overview");
  });

  it("sends a user with no businesses to onboarding", () => {
    expect(
      resolvePostLoginDestination({ businesses: [], activeBusinessId: null, nextPath: null }),
    ).toBe("/businesses/new");
  });
});

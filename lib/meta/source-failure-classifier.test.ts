import { describe, expect, it } from "vitest";

import { classifySourceFailure } from "@/lib/meta/source-failure-classifier";
import { META_FAILURES } from "@/lib/meta/read-state-contract";

/**
 * WP9: "Ham Error.message basılmaz."
 *
 * Two independent reasons, and the tests below cover both. A driver error
 * carries the failing SQL, table and column names and sometimes bound
 * parameters; a fetch error carries the URL, which for a provider call can
 * carry an access token. And separately, none of that text tells a media buyer
 * anything they can act on.
 */
describe("classifySourceFailure", () => {
  it("keeps the raw text for the log and off the screen", () => {
    const failure = classifySourceFailure(
      new Error('relation "meta_page_status" does not exist'),
    );
    expect(failure.detail).toContain("meta_page_status");
    expect(failure.message).not.toContain("meta_page_status");
    expect(failure.message).toBe(META_FAILURES[failure.code].message);
  });

  it("classifies a missing relation by driver code, not by prose", () => {
    // Structure first: a driver code is a fact, a substring match is a guess.
    const failure = classifySourceFailure(
      Object.assign(new Error("boom"), { code: "42P01" }),
    );
    expect(failure.code).toBe("schema_not_ready");
  });

  it("classifies an expired token", () => {
    for (const error of [
      new Error("Meta access token has expired. Please reconnect."),
      Object.assign(new Error("nope"), { status: 401 }),
      new Error("Meta access token is missing for this business integration."),
    ]) {
      expect(classifySourceFailure(error).code).toBe("provider_auth_expired");
    }
  });

  it("classifies rate limiting and permission separately", () => {
    expect(
      classifySourceFailure(Object.assign(new Error("x"), { status: 429 })).code,
    ).toBe("provider_rate_limited");
    expect(classifySourceFailure(new Error("User rate limit reached")).code).toBe(
      "provider_rate_limited",
    );
    expect(
      classifySourceFailure(Object.assign(new Error("x"), { status: 403 })).code,
    ).toBe("capability_read_denied");
    expect(
      classifySourceFailure(new Error("(#200) Missing permission")).code,
    ).toBe("capability_read_denied");
  });

  it("falls back to source_read_failed without claiming to know why", () => {
    // The honest answer for something unrecognised: the read did not succeed,
    // and we are not going to invent a cause.
    for (const error of [
      new Error("ECONNRESET"),
      "a string",
      null,
      { weird: true },
    ]) {
      expect(classifySourceFailure(error).code).toBe("source_read_failed");
    }
  });

  it("never returns an empty operator sentence", () => {
    for (const error of [new Error(""), null, undefined]) {
      const failure = classifySourceFailure(error);
      expect(failure.message.length).toBeGreaterThan(30);
    }
  });

  it("does not leak a token that arrived inside an error message", () => {
    // The specific leak: a fetch error's message can carry the request URL.
    const failure = classifySourceFailure(
      new Error(
        "request to https://graph.facebook.com/v20.0/me?access_token=EAAsecret123 failed",
      ),
    );
    expect(failure.message).not.toContain("EAAsecret123");
    expect(failure.message).not.toContain("access_token");
  });
});

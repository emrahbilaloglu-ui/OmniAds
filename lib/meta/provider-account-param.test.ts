import { describe, expect, it, vi } from "vitest";

import {
  canonicalMetaAccountId,
  readProviderAccountParam,
  sameMetaAccount,
} from "@/lib/meta/provider-account-param";

describe("readProviderAccountParam", () => {
  it("reads the canonical spelling", () => {
    expect(
      readProviderAccountParam(new URLSearchParams("providerAccountId=act_1")),
    ).toEqual({ requestedAccountId: "act_1", source: "canonical" });
  });

  it("reads the deprecated alias and reports it once", () => {
    const onDeprecatedAlias = vi.fn();
    const read = readProviderAccountParam(new URLSearchParams("accountId=act_9"), {
      onDeprecatedAlias,
    });
    expect(read).toEqual({ requestedAccountId: "act_9", source: "deprecated_alias" });
    expect(onDeprecatedAlias).toHaveBeenCalledExactlyOnceWith("act_9");
  });

  it("prefers the canonical spelling and does not report the alias", () => {
    // Two different ids in one URL is a caller bug; picking the "more specific"
    // one would be guessing at an intent nobody stated.
    const onDeprecatedAlias = vi.fn();
    const read = readProviderAccountParam(
      new URLSearchParams("providerAccountId=act_1&accountId=act_2"),
      { onDeprecatedAlias },
    );
    expect(read.requestedAccountId).toBe("act_1");
    expect(read.source).toBe("canonical");
    expect(onDeprecatedAlias).not.toHaveBeenCalled();
  });

  it("reads a Next searchParams record and its array form", () => {
    expect(
      readProviderAccountParam({ providerAccountId: "act_3" }).requestedAccountId,
    ).toBe("act_3");
    expect(
      readProviderAccountParam({ providerAccountId: ["act_4", "act_5"] })
        .requestedAccountId,
    ).toBe("act_4");
  });

  it("treats blank and missing alike", () => {
    for (const source of [
      undefined,
      null,
      {},
      { providerAccountId: "" },
      { providerAccountId: "   " },
      new URLSearchParams("providerAccountId="),
    ]) {
      expect(readProviderAccountParam(source)).toEqual({
        requestedAccountId: null,
        source: "absent",
      });
    }
  });
});

describe("canonicalMetaAccountId", () => {
  it("adds the prefix Meta's own account edge returns", () => {
    expect(canonicalMetaAccountId("123456")).toBe("act_123456");
    expect(canonicalMetaAccountId("act_123456")).toBe("act_123456");
    expect(canonicalMetaAccountId(" 123456 ")).toBe("act_123456");
  });

  it("returns an unrecognised id unchanged rather than coercing it", () => {
    // Coercion could make a malformed id match a real assignment. Returned as
    // it came so the assignment check refuses it.
    for (const raw of ["act_", "act_abc", "abc", "act_12a", "12 34"]) {
      expect(canonicalMetaAccountId(raw)).toBe(raw.trim());
    }
  });

  it("is null for nothing", () => {
    for (const raw of [null, undefined, "", "   "]) {
      expect(canonicalMetaAccountId(raw)).toBeNull();
    }
  });
});

describe("sameMetaAccount", () => {
  it("matches across the prefix boundary", () => {
    // §7.2: the same account under two spellings previously failed to match
    // itself, so a correctly-assigned account resolved to null and the surface
    // refused.
    expect(sameMetaAccount("123456", "act_123456")).toBe(true);
    expect(sameMetaAccount("act_123456", "123456")).toBe(true);
  });

  it("does not match different accounts or nothing", () => {
    expect(sameMetaAccount("act_1", "act_2")).toBe(false);
    expect(sameMetaAccount(null, null)).toBe(false);
    expect(sameMetaAccount("act_1", null)).toBe(false);
  });
});

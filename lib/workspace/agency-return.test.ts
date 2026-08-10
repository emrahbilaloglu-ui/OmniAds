import { describe, expect, it } from "vitest";

import {
  AGENCY_RETURN_FALLBACK,
  buildAgencyReturn,
  parseAgencyReturn,
  resolveAgencyReturnHref,
} from "@/lib/workspace/agency-return";

describe("parseAgencyReturn", () => {
  it("accepts the two allowlisted paths", () => {
    expect(parseAgencyReturn("/a/desk")).toEqual({
      path: "/a/desk",
      q: null,
      cursor: null,
      row: null,
    });
    expect(parseAgencyReturn("/a/desk/clients")?.path).toBe("/a/desk/clients");
  });

  it("preserves search, cursor and row anchor", () => {
    expect(parseAgencyReturn("/a/desk/clients?q=acme&cursor=c_2&row=biz_7")).toEqual({
      path: "/a/desk/clients",
      q: "acme",
      cursor: "c_2",
      row: "biz_7",
    });
  });

  it("rejects arbitrary redirect targets", () => {
    const hostile = [
      "https://evil.example/a/desk",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/a/desk/../../c/biz_9/home",
      "/c/biz_9/home",
      "/a/desk/withheld",
      "/a/deskx",
      "/A/DESK",
      "javascript:alert(1)",
      "",
      null,
      undefined,
    ];
    for (const raw of hostile) {
      expect(parseAgencyReturn(raw), String(raw)).toBeNull();
    }
  });

  it("rejects unknown query parameters instead of dropping them", () => {
    expect(parseAgencyReturn("/a/desk?q=a&next=/c/biz_9/home")).toBeNull();
    expect(parseAgencyReturn("/a/desk?returnTo=/a/desk")).toBeNull();
  });

  it("rejects over-long parameter values rather than truncating", () => {
    expect(parseAgencyReturn(`/a/desk?q=${"x".repeat(257)}`)).toBeNull();
    expect(parseAgencyReturn(`/a/desk?q=${"x".repeat(256)}`)?.q).toHaveLength(256);
  });

  it("treats an empty allowlisted parameter as absent", () => {
    expect(parseAgencyReturn("/a/desk?q=&cursor=")).toEqual({
      path: "/a/desk",
      q: null,
      cursor: null,
      row: null,
    });
  });
});

describe("buildAgencyReturn", () => {
  it("omits empty parameters and round-trips through the parser", () => {
    expect(buildAgencyReturn({ path: "/a/desk" })).toBe("/a/desk");
    const built = buildAgencyReturn({ path: "/a/desk/clients", q: "acme", row: "biz_7" });
    expect(built).toBe("/a/desk/clients?q=acme&row=biz_7");
    expect(parseAgencyReturn(built)).toEqual({
      path: "/a/desk/clients",
      q: "acme",
      cursor: null,
      row: "biz_7",
    });
  });

  it("encodes values so a crafted search term cannot inject a parameter", () => {
    const built = buildAgencyReturn({ path: "/a/desk", q: "a&row=biz_9" });
    expect(parseAgencyReturn(built)).toEqual({
      path: "/a/desk",
      q: "a&row=biz_9",
      cursor: null,
      row: null,
    });
  });
});

describe("resolveAgencyReturnHref", () => {
  it("falls back to the desk instead of failing on a tampered value", () => {
    expect(resolveAgencyReturnHref("https://evil.example")).toBe(AGENCY_RETURN_FALLBACK);
    expect(resolveAgencyReturnHref(null)).toBe(AGENCY_RETURN_FALLBACK);
    expect(resolveAgencyReturnHref("/a/desk/clients?q=acme")).toBe("/a/desk/clients?q=acme");
  });
});

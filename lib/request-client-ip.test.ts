import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getTrustedClientIp } from "./request-client-ip";

function requestWith(headers: Record<string, string>) {
  return new NextRequest("https://adsecute.com/api/auth/login", { headers });
}

/**
 * The limiter is only as good as this function. nginx OVERWRITES X-Real-IP with
 * $remote_addr, but builds X-Forwarded-For with $proxy_add_x_forwarded_for,
 * which APPENDS the real address to whatever the client sent — so XFF's first
 * entry is attacker-controlled and must never be read.
 */
describe("getTrustedClientIp", () => {
  it("reads X-Real-IP, which the edge overwrites", () => {
    expect(getTrustedClientIp(requestWith({ "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("ignores X-Forwarded-For entirely, even when it is the only header", () => {
    expect(
      getTrustedClientIp(requestWith({ "x-forwarded-for": "203.0.113.7" })),
      "reading XFF would let one client mint unlimited identities with a header",
    ).toBeNull();
  });

  it("does not let a spoofed X-Forwarded-For override the real address", () => {
    expect(
      getTrustedClientIp(
        requestWith({ "x-forwarded-for": "1.2.3.4, 203.0.113.7", "x-real-ip": "203.0.113.7" }),
      ),
    ).toBe("203.0.113.7");
  });

  it("rejects junk rather than keying a bucket on it", () => {
    expect(getTrustedClientIp(requestWith({ "x-real-ip": "not-an-ip" }))).toBeNull();
    expect(getTrustedClientIp(requestWith({ "x-real-ip": "" }))).toBeNull();
    expect(getTrustedClientIp(requestWith({ "x-real-ip": "a".repeat(200) }))).toBeNull();
    expect(getTrustedClientIp(requestWith({}))).toBeNull();
  });

  it("accepts IPv6", () => {
    expect(getTrustedClientIp(requestWith({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1");
  });
});

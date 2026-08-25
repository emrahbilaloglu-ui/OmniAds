import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "@/proxy";

function buildRequest(input: {
  pathname: string;
  bearerToken?: string;
  sessionToken?: string;
  method?: string;
}) {
  const headers = new Headers();
  if (input.bearerToken) {
    headers.set("authorization", `Bearer ${input.bearerToken}`);
  }

  const request = new NextRequest(`http://localhost${input.pathname}`, {
    headers,
    method: input.method,
  });

  if (input.sessionToken) {
    request.cookies.set("omniads_session", input.sessionToken);
  }

  return request;
}

describe("proxy internal sync auth", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "secret";
  });

  it("blocks sync refresh without session or internal auth", async () => {
    const response = proxy(
      buildRequest({
        pathname: "/api/sync/refresh",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "auth_error",
      message: "Authentication required.",
    });
  });

  it("allows sync refresh with a valid CRON_SECRET bearer token", () => {
    const response = proxy(
      buildRequest({
        pathname: "/api/sync/refresh",
        bearerToken: "secret",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not broadly expose other protected sync or meta routes to CRON_SECRET", async () => {
    const soakResponse = proxy(
      buildRequest({
        pathname: "/api/sync/soak",
        bearerToken: "secret",
      }),
    );
    expect(soakResponse.status).toBe(401);
    await expect(soakResponse.json()).resolves.toEqual({
      error: "auth_error",
      message: "Authentication required.",
    });

    const metaResponse = proxy(
      buildRequest({
        pathname: "/api/meta/status",
        bearerToken: "secret",
      }),
    );
    expect(metaResponse.status).toBe(401);
    await expect(metaResponse.json()).resolves.toEqual({
      error: "auth_error",
      message: "Authentication required.",
    });
  });

  it("allows the public release authority route without a session", () => {
    const response = proxy(
      buildRequest({
        pathname: "/api/release-authority",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("allows the lightweight health route without a session", () => {
    const response = proxy(
      buildRequest({
        pathname: "/api/healthz",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("exposes the password-reset flow without a session", () => {
    for (const pathname of [
      "/forgot-password",
      "/reset-password",
      "/api/auth/password-reset/request",
      "/api/auth/password-reset/confirm",
    ]) {
      const response = proxy(buildRequest({ pathname }));
      expect(response.status, pathname).toBe(200);
      expect(response.headers.get("x-middleware-next"), pathname).toBe("1");
    }
  });

  it("hydrates a default language cookie for authenticated page requests", () => {
    const response = proxy(
      buildRequest({
        pathname: "/platforms/meta",
        sessionToken: "session_123",
      }),
    );

    // The proxy used to redirect this path to /app/meta/decisions and hydrate
    // the cookie on the way past. It now lets the page answer for itself, so
    // the cookie has to survive on the pass-through — which is the branch that
    // serves every other signed-in page request anyway.
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.cookies.get("adsecute_locale")?.value).toBe("en");
  });

  it("allows only public creative-share reads and marks them no-store", async () => {
    const readResponse = proxy(
      buildRequest({
        pathname: "/api/creatives/share/share_token",
      }),
    );
    expect(readResponse.status).toBe(200);
    expect(readResponse.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");

    for (const request of [
      buildRequest({ pathname: "/api/creatives/share", method: "POST" }),
      buildRequest({ pathname: "/api/creatives/share/share_token", method: "DELETE" }),
    ]) {
      const response = proxy(request);
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "auth_error",
        message: "Authentication required.",
      });
    }
  });

  it("lets an anonymous recipient post one note, and nothing else", async () => {
    /*
     * The public page invites anyone holding the link to reply, and the handler
     * documents itself as unauthenticated — but this proxy allowed only reads
     * with no further path segment, so every Send answered 401. Proven at
     * runtime in meta-runtime-share-lifecycle.spec.ts before it was fixed.
     */
    const allowed = proxy(
      buildRequest({
        pathname: "/api/creatives/share/share_token/messages",
        method: "POST",
      }),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("x-middleware-next")).toBe("1");

    // The allowance is the narrowest shape that works: this method, this depth,
    // this last segment. Everything adjacent still needs a session.
    for (const request of [
      buildRequest({ pathname: "/api/creatives/share/share_token/messages", method: "GET" }),
      buildRequest({ pathname: "/api/creatives/share/share_token/messages", method: "DELETE" }),
      buildRequest({ pathname: "/api/creatives/share/share_token/csv", method: "POST" }),
      buildRequest({ pathname: "/api/creatives/share/share_token/messages/x", method: "POST" }),
      buildRequest({ pathname: "/api/creatives/share//messages", method: "POST" }),
    ]) {
      const response = proxy(request);
      expect(
        response.status,
        `${request.method} ${request.nextUrl.pathname} was let through`,
      ).toBe(401);
    }
  });

  it("allows authenticated creative-share writes", () => {
    for (const request of [
      buildRequest({
        pathname: "/api/creatives/share",
        method: "POST",
        sessionToken: "session_123",
      }),
      buildRequest({
        pathname: "/api/creatives/share/share_token",
        method: "DELETE",
        sessionToken: "session_123",
      }),
    ]) {
      const response = proxy(request);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("marks public creative-share pages no-store", () => {
    const response = proxy(
      buildRequest({
        pathname: "/share/creative/share_token",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
  });
});

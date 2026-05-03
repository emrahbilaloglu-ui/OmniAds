import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "@/proxy";

function buildRequest(input: {
  pathname: string;
  bearerToken?: string;
  sessionToken?: string;
}) {
  const headers = new Headers();
  if (input.bearerToken) {
    headers.set("authorization", `Bearer ${input.bearerToken}`);
  }

  const request = new NextRequest(`http://localhost${input.pathname}`, {
    headers,
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

  it("hydrates a default language cookie for authenticated page requests", () => {
    const response = proxy(
      buildRequest({
        pathname: "/platforms/meta",
        sessionToken: "session_123",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.cookies.get("adsecute_locale")?.value).toBe("en");
  });
});

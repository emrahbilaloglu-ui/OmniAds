import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The reset link used to be built from `request.nextUrl.origin`.
 *
 * That origin is NOT attacker-controllable — Next's standalone server pins it
 * to HOSTNAME:PORT and ignores the Host header unless
 * `experimental.trustHostHeader` is set, which it is not. The damage ran the
 * other way: the pinned value is the bind address, so every emailed link
 * pointed at http://0.0.0.0:3000 and no recipient could open it.
 *
 * These tests execute the route and assert on the link that actually reaches
 * the mailer, so they fail if the origin is ever taken from the request again.
 */

const sendEmail = vi.fn();
const getUserByEmail = vi.fn();
const createPasswordResetToken = vi.fn();

vi.mock("@/lib/email/mailer", () => ({
  isEmailConfigured: () => true,
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));
vi.mock("@/lib/account-store", () => ({
  getUserByEmail: (...args: unknown[]) => getUserByEmail(...args),
}));
vi.mock("@/lib/password-reset-store", () => ({
  createPasswordResetToken: (...args: unknown[]) => createPasswordResetToken(...args),
}));
vi.mock("@/lib/request-language", () => ({
  resolveRequestLanguage: async () => "en",
}));
vi.mock("@/lib/startup-diagnostics", () => ({ logStartupError: vi.fn() }));

function requestWith(headers: Record<string, string> = {}) {
  return new NextRequest("http://0.0.0.0:3000/api/auth/password-reset/request", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email: "victim@example.com" }),
  });
}

function emailedLink(): string {
  const body = sendEmail.mock.calls[0]?.[0] as { text: string } | undefined;
  const match = body?.text.match(/https?:\/\/\S+/);
  return match?.[0] ?? "";
}

describe("password reset link origin", () => {
  beforeEach(() => {
    vi.resetModules();
    sendEmail.mockReset().mockResolvedValue(undefined);
    getUserByEmail.mockReset().mockResolvedValue({ id: "user-1" });
    createPasswordResetToken.mockReset().mockResolvedValue("t0k3n");
    process.env.NEXT_PUBLIC_APP_URL = "https://adsecute.com";
  });

  it("builds the link from the configured app URL", async () => {
    const { POST } = await import("./route");
    const response = await POST(requestWith());

    expect(response.status).toBe(200);
    expect(emailedLink()).toContain("https://adsecute.com/reset-password");
  });

  it("never emails the bind address, whatever the request origin was", async () => {
    const { POST } = await import("./route");
    await POST(requestWith());
    expect(emailedLink()).not.toContain("0.0.0.0");
  });

  it("ignores a forged Host and X-Forwarded-Host", async () => {
    const { POST } = await import("./route");
    await POST(requestWith({ host: "evil.example", "x-forwarded-host": "evil.example" }));
    expect(emailedLink()).toContain("https://adsecute.com/");
    expect(emailedLink()).not.toContain("evil.example");
  });

  it("puts the token in the fragment, never the query string", async () => {
    const { POST } = await import("./route");
    await POST(requestWith());

    const link = emailedLink();
    expect(link, "a query-string token lands in nginx access logs").not.toMatch(/\?token=/);
    expect(link).toContain("#token=t0k3n");
  });

  it("refuses to send when no app URL is configured in production", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    vi.stubEnv("NODE_ENV", "production");

    const { POST } = await import("./route");
    const response = await POST(requestWith());

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: "app_url_not_configured" });
    expect(sendEmail, "better to send nothing than to mail a dead link").not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("gives no account-existence oracle when delivery fails", async () => {
    sendEmail.mockRejectedValue(new Error("resend is down"));
    const { POST } = await import("./route");
    const failed = await POST(requestWith());

    getUserByEmail.mockResolvedValue(null);
    const unknown = await POST(requestWith());

    // A distinct 502 was only reachable once a user had been found, so it told
    // a stranger which addresses are real.
    expect(failed.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await failed.json()).toEqual(await unknown.json());
  });
});

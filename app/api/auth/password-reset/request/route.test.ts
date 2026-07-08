import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/auth/password-reset/request", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/auth/password-reset/request", () => {
  it("rejects invalid email values", async () => {
    const response = await POST(request({ email: "not-an-email" }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("invalid_email");
  });

  it("does not claim an email was sent when delivery is not configured", async () => {
    const response = await POST(request({ email: "owner@example.com" }));
    const payload = await response.json();

    expect(response.status).toBe(501);
    expect(payload.error).toBe("email_delivery_not_configured");
    expect(payload.message).toContain("no email was sent");
  });
});

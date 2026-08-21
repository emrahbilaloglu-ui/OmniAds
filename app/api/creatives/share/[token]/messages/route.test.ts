import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/creative-share-store", () => ({
  appendCreativeShareMessage: vi.fn(),
}));

const shareStore = await import("@/lib/creative-share-store");
const { POST } = await import("@/app/api/creatives/share/[token]/messages/route");

const TOKEN = "a".repeat(32);
const context = { params: Promise.resolve({ token: TOKEN }) };

function request(body: unknown) {
  return new NextRequest("http://localhost/api/creatives/share/token/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/creatives/share/[token]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires no session — the public page has none", async () => {
    vi.mocked(shareStore.appendCreativeShareMessage).mockResolvedValue({
      ok: true,
      messages: [
        { id: "m1", who: "viewer", name: "Client", text: "Is this hook or offer?", postedAt: "2026-08-14T00:00:00.000Z" },
      ],
    });
    const response = await POST(request({ text: "Is this hook or offer?" }), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages).toHaveLength(1);
    expect(shareStore.appendCreativeShareMessage).toHaveBeenCalledWith({
      token: TOKEN,
      text: "Is this hook or offer?",
    });
  });

  it("refuses empty text before it ever reaches the store", async () => {
    const response = await POST(request({ text: "   " }), context);
    expect(response.status).toBe(400);
    expect(shareStore.appendCreativeShareMessage).not.toHaveBeenCalled();
  });

  it("gives a dead token the same neutral response the rest of the public surface uses", async () => {
    vi.mocked(shareStore.appendCreativeShareMessage).mockResolvedValue({
      ok: false,
      reason: "not_found",
    });
    const response = await POST(request({ text: "hello" }), context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.message).toMatch(/not found, revoked, or expired/);
  });

  it("states the thread limit truthfully instead of a generic failure", async () => {
    vi.mocked(shareStore.appendCreativeShareMessage).mockResolvedValue({
      ok: false,
      reason: "limit_reached",
    });
    const response = await POST(request({ text: "hello" }), context);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("limit_reached");
  });

  it("rejects a malformed token before touching the store", async () => {
    const response = await POST(request({ text: "hello" }), {
      params: Promise.resolve({ token: "not-a-token" }),
    });
    expect(response.status).toBe(404);
    expect(shareStore.appendCreativeShareMessage).not.toHaveBeenCalled();
  });
});

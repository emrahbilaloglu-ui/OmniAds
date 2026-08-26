import { afterEach, describe, expect, it, vi } from "vitest";

const { GET: downloadCsv } = await import(
  "@/app/dev-preview-share/csv/route"
);
const { POST: postMessage } = await import(
  "@/app/dev-preview-share/messages/route"
);

function messageRequest(body: unknown) {
  return new Request("http://localhost/dev-preview-share/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("development public-share preview endpoints", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("downloads the sanitized buyer CSV without internal fixture identity", async () => {
    const response = downloadCsv();
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(csv.startsWith("Creative,Format,Created,Spend,Revenue,ROAS,CPA,CTR,Purchases,Thumbstop,Video 25%,Video 50%,Video 75%,Video 100%"))
      .toBe(true);
    expect(csv).toContain("Hero video — product in motion");
    expect(csv).not.toContain("dev_preview_internal_business");
    expect(csv).not.toContain("act_dev_preview_internal");
    expect(csv).not.toContain("private-preview@example.com");
  });

  it("accepts a bounded preview note and returns the updated in-memory thread", async () => {
    const response = await postMessage(messageRequest({ text: "  Please test a new opener.  " }));
    const body = (await response.json()) as {
      messages: Array<{ text: string; who: string }>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(body.messages.at(-1)).toMatchObject({
      text: "Please test a new opener.",
      who: "viewer",
    });
  });

  it.each([
    ["empty", { text: "   " }, "empty_text"],
    ["too long", { text: "x".repeat(601) }, "invalid_text"],
  ] as const)("rejects a %s preview note", async (_label, body, error) => {
    const response = await postMessage(messageRequest(body));
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe(error);
  });

  it("returns neutral 404s for both endpoints in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const csv = downloadCsv();
    const messages = await postMessage(messageRequest({ text: "hello" }));

    expect(csv.status).toBe(404);
    expect(messages.status).toBe(404);
    expect(await csv.json()).toMatchObject({ error: "not_found" });
    expect(await messages.json()).toMatchObject({ error: "not_found" });
  });
});

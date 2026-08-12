/**
 * Both branches of the report-share mint endpoint.
 *
 * Flag off is the deployed behavior and must stay byte-compatible. Flag on is
 * the zero-base end state: it is asserted to read nothing and write nothing, so
 * a refusal cannot be used to learn which report IDs exist, and no stored
 * snapshot is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
  listUserBusinesses: vi.fn(),
}));
vi.mock("@/lib/custom-report-store", () => ({
  getCustomReportById: vi.fn(),
  createCustomReportShareSnapshot: vi.fn(),
}));
vi.mock("@/lib/custom-report-renderer", () => ({ renderCustomReportRecord: vi.fn() }));
vi.mock("@/lib/product-instrumentation", () => ({
  recordProductInstrumentationEvent: vi.fn(),
}));

const { POST } = await import("@/app/api/reports/[reportId]/share/route");
const access = await import("@/lib/access");
const store = await import("@/lib/custom-report-store");
const renderer = await import("@/lib/custom-report-renderer");
const instrumentation = await import("@/lib/product-instrumentation");
const { REPORT_SHARE_DISABLED_RESPONSE } = await import("@/lib/reports/share-fail-closed");

const ORIGINAL_FLAG = process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED;

function request(body: unknown = {}) {
  return new NextRequest("https://app.example/api/reports/rep_1/share", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = (reportId = "rep_1") => ({ params: Promise.resolve({ reportId }) });

function seedHappyPath() {
  vi.mocked(store.getCustomReportById).mockResolvedValue({
    id: "rep_1",
    businessId: "biz_1",
  } as never);
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user_1" } },
    membership: { role: "admin" },
  } as never);
  vi.mocked(access.listUserBusinesses).mockResolvedValue([
    { id: "biz_1", name: "Acme", currency: "USD" },
  ] as never);
  vi.mocked(renderer.renderCustomReportRecord).mockResolvedValue({
    name: "Report",
  } as never);
  vi.mocked(store.createCustomReportShareSnapshot).mockResolvedValue({
    token: "tok_abc",
    expiresAt: "2026-09-01T00:00:00.000Z",
  } as never);
}

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED;
  else process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED = ORIGINAL_FLAG;
});

describe("POST share — flag off (default, deployed behavior)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED;
    seedHappyPath();
  });

  it("defaults to enabled when the flag is unset", async () => {
    const response = await POST(request(), params());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      token: "tok_abc",
      url: "/share/report/tok_abc",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });
    expect(store.createCustomReportShareSnapshot).toHaveBeenCalledTimes(1);
  });

  it("still mints when the flag is explicitly false", async () => {
    process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED = "false";
    expect((await POST(request(), params())).status).toBe(200);
  });

  it("keeps 404 for an unknown report", async () => {
    vi.mocked(store.getCustomReportById).mockResolvedValue(null as never);
    const response = await POST(request(), params("missing"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "not_found",
      message: "Report not found.",
    });
  });

  it("still enforces business access", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: Response.json({ error: "auth_error" }, { status: 403 }),
    } as never);
    expect((await POST(request(), params())).status).toBe(403);
    expect(store.createCustomReportShareSnapshot).not.toHaveBeenCalled();
  });
});

describe("POST share — flag on (fail closed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED = "true";
    seedHappyPath();
  });

  it("refuses with a stable prerequisites body", async () => {
    const response = await POST(request(), params());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(REPORT_SHARE_DISABLED_RESPONSE);
  });

  it("reads nothing and writes nothing", async () => {
    await POST(request(), params());
    expect(store.getCustomReportById).not.toHaveBeenCalled();
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(renderer.renderCustomReportRecord).not.toHaveBeenCalled();
    expect(store.createCustomReportShareSnapshot).not.toHaveBeenCalled();
    expect(instrumentation.recordProductInstrumentationEvent).not.toHaveBeenCalled();
  });

  it("returns the identical response for existing and non-existent reports", async () => {
    const existing = await POST(request(), params("rep_1"));
    vi.mocked(store.getCustomReportById).mockResolvedValue(null as never);
    const missing = await POST(request(), params("does-not-exist"));

    expect(existing.status).toBe(missing.status);
    expect(await existing.json()).toEqual(await missing.json());
  });

  it("refuses guest and admin callers alike", async () => {
    for (const role of ["guest", "admin"] as const) {
      vi.mocked(access.requireBusinessAccess).mockResolvedValue({
        session: { user: { id: "user_1" } },
        membership: { role },
      } as never);
      const response = await POST(request(), params());
      expect(response.status, role).toBe(409);
      await expect(response.json()).resolves.toEqual(REPORT_SHARE_DISABLED_RESPONSE);
    }
  });

  it("only an exact true enables the refusal", async () => {
    for (const raw of ["1", "yes", "TRUE ", "on"]) {
      vi.clearAllMocks();
      seedHappyPath();
      process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED = raw;
      const response = await POST(request(), params());
      // "TRUE " trims and lowercases to true; the rest do not enable it.
      expect(response.status, raw).toBe(raw.trim().toLowerCase() === "true" ? 409 : 200);
    }
  });
});

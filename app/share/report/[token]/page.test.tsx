/**
 * Both branches of the public shared-report page.
 *
 * The flag-on assertions are the point: the page must not read the token or
 * the snapshot at all. Resolving the token and then discarding the result
 * would still leave a timing oracle distinguishing a live token from a fake
 * one, so the test proves the token promise is never awaited and that two
 * different tokens produce identical markup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/custom-report-store", () => ({ getCustomReportShareSnapshot: vi.fn() }));
vi.mock("@/components/reports/report-canvas", () => ({
  ReportCanvas: () => null,
}));
vi.mock("@/components/client/ClientPanelPrintButton", () => ({
  ClientPanelPrintButton: () => null,
}));

const ShareReportPage = (await import("@/app/share/report/[token]/page")).default;
const headers = await import("next/headers");
const store = await import("@/lib/custom-report-store");

const ORIGINAL_FLAG = process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED;

/** A params promise that records whether anything ever awaited it. */
function trackedParams(token: string) {
  const state = { awaited: false };
  const promise = {
    then(...args: Parameters<Promise<{ token: string }>["then"]>) {
      state.awaited = true;
      return Promise.resolve({ token }).then(...args);
    },
  } as unknown as Promise<{ token: string }>;
  return { params: promise, state };
}

async function render(token: string) {
  const { params, state } = trackedParams(token);
  const element = await ShareReportPage({ params });
  return { html: renderToStaticMarkup(element), tokenAwaited: state.awaited };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(headers.cookies).mockResolvedValue({
    get: () => ({ value: "en" }),
  } as never);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED;
  else process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED = ORIGINAL_FLAG;
});

describe("shared report page — flag off (default, deployed behavior)", () => {
  beforeEach(() => {
    delete process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED;
  });

  it("renders a live snapshot", async () => {
    vi.mocked(store.getCustomReportShareSnapshot).mockResolvedValue({
      name: "Q3 performance",
      description: null,
      dateRangeLabel: "Jul 1 – Jul 31",
      generatedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
      businessName: "Acme",
      businessId: "biz_1",
      currency: "USD",
      clientEmail: null,
      widgets: [],
    } as never);

    const { html, tokenAwaited } = await render("tok_live");
    expect(tokenAwaited).toBe(true);
    expect(store.getCustomReportShareSnapshot).toHaveBeenCalledWith("tok_live");
    expect(html).toContain("Q3 performance");
    expect(html).toContain("Acme");
  });

  it("keeps the not-found state for an unknown token", async () => {
    vi.mocked(store.getCustomReportShareSnapshot).mockResolvedValue(null as never);
    const { html } = await render("tok_missing");
    expect(html).toContain("Share link not found or expired");
  });
});

describe("shared report page — flag on (fail closed)", () => {
  beforeEach(() => {
    process.env.ZERO_BASE_REPORT_SHARE_FAIL_CLOSED = "true";
    vi.mocked(store.getCustomReportShareSnapshot).mockResolvedValue({
      name: "Q3 performance",
      businessName: "Acme",
      widgets: [],
    } as never);
  });

  it("performs zero token and snapshot reads", async () => {
    const { tokenAwaited } = await render("tok_live");
    expect(tokenAwaited).toBe(false);
    expect(store.getCustomReportShareSnapshot).not.toHaveBeenCalled();
  });

  it("renders a static disabled state with no report data", async () => {
    const { html } = await render("tok_live");
    expect(html).toContain("Report sharing is unavailable");
    expect(html).not.toContain("Q3 performance");
    expect(html).not.toContain("Acme");
    expect(html).not.toContain("tok_live");
  });

  it("produces identical markup for a live token and a fabricated one", async () => {
    const live = await render("tok_live");
    const fake = await render("completely-made-up-token");
    expect(live.html).toBe(fake.html);
  });

  it("resolves copy through the app's language path, not the token", async () => {
    // `getLanguageFromCookieValue` is currently pinned to "en" app-wide, so the
    // cookie cannot change the output — but the disabled state must still go
    // through that resolver rather than hardcoding a string, and must not vary
    // with the token.
    const withCookie = async (value: string) => {
      vi.mocked(headers.cookies).mockResolvedValue({
        get: () => ({ value }),
      } as never);
      return (await render("tok_live")).html;
    };
    expect(await withCookie("tr")).toBe(await withCookie("en"));
    expect(await withCookie("en")).toContain("Report sharing is unavailable");
  });
});

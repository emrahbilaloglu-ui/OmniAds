import { afterEach, describe, expect, it } from "vitest";
import { resolveReportSourceTransport } from "@/lib/custom-report-renderer";

const original = process.env.REPORT_RENDER_TRANSPORT;

afterEach(() => {
  if (original === undefined) delete process.env.REPORT_RENDER_TRANSPORT;
  else process.env.REPORT_RENDER_TRANSPORT = original;
});

/**
 * Every report widget used to reach its own API route by fetching this
 * service's own public origin. When that self-call fails in a container, every
 * widget fails at once and the whole report reads "Widget failed to load".
 */
describe("report data sources avoid the self-fetch hop", () => {
  it("resolves each report source in-process when enabled", () => {
    process.env.REPORT_RENDER_TRANSPORT = "in_process";
    for (const path of [
      "/api/overview-summary",
      "/api/overview-sparklines",
      "/api/reports/breakdown",
      "/api/reports/time-breakdown",
      "/api/meta/campaigns",
      "/api/google-ads/campaigns",
    ]) {
      expect(resolveReportSourceTransport(path)).toBe("in_process");
    }
  });

  it("falls back to HTTP for a path it does not own", () => {
    process.env.REPORT_RENDER_TRANSPORT = "in_process";
    expect(resolveReportSourceTransport("/api/something-else")).toBe("http");
  });

  it("honours an explicit HTTP override so the transport stays debuggable", () => {
    process.env.REPORT_RENDER_TRANSPORT = "http";
    expect(resolveReportSourceTransport("/api/overview-summary")).toBe("http");
  });

  it("keeps tests on the HTTP path so route mocks remain meaningful", () => {
    delete process.env.REPORT_RENDER_TRANSPORT;
    expect(resolveReportSourceTransport("/api/overview-summary")).toBe("http");
  });
});

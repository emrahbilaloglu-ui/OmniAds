/**
 * D084 Correction 5 / E — the evidence package verifies itself.
 *
 * r5's desktop receipt named
 * `playwright/.evidence/d084-authenticated/authenticated-desktop-1440.png`
 * and that file was never written. `find` returned a README and two JSON
 * files. Nothing in the suite noticed, so a receipt could advertise proof that
 * did not exist.
 *
 * These tests make that impossible: every file a receipt references must exist,
 * and when it is an image its byte hash and pixel dimensions must match what
 * the receipt claims. A receipt that declines to reference a screenshot must
 * say so explicitly and explain why, so silence can never pass for evidence.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = "playwright/.evidence/d084-authenticated";

interface Receipt {
  receiptKind: string;
  screenshot: string | null;
  screenshotStatus?: string;
  screenshotWhy?: string;
  screenshotSha256?: string;
  screenshotDimensions?: { width: number; height: number };
  supplementalScreenshots?: Array<{
    path: string;
    sha256: string;
    dimensions: { width: number; height: number };
  }>;
  requestAudit?: {
    totalRequestsObserved: number;
    methodsObserved: Record<string, number>;
    mutatingApplicationRequests: number;
    byMethodUrlClassStatus: Array<{ method: string; urlClass: string; status: number | null; count: number }>;
  };
  verdict: string;
  [k: string]: unknown;
}

const receiptFiles = readdirSync(resolve(DIR)).filter((f) => f.endsWith(".json")).sort();
const receipts = receiptFiles.map((f) => ({
  file: f,
  body: JSON.parse(readFileSync(resolve(DIR, f), "utf8")) as Receipt,
}));

/** PNG/JPEG intrinsic size, read from the file's own header. */
function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  return null;
}

describe("D084 authenticated evidence receipts", () => {
  it("finds the receipts at all", () => {
    // Non-vacuity: an empty directory must not silently pass every test below.
    expect(receipts.length).toBeGreaterThanOrEqual(2);
    expect(receiptFiles).toContain("layout-authenticated-desktop-1440.json");
    expect(receiptFiles).toContain("layout-authenticated-mobile-390.json");
  });

  it.each(receipts)("$file references no file that is missing", ({ body }) => {
    // Any string field that looks like a repo path to an evidence artifact.
    const referenced: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") {
        if (/^playwright\/\.evidence\/.+\.(png|jpe?g|json|md)$/.test(v)) referenced.push(v);
        return;
      }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === "object") { Object.values(v).forEach(walk); }
    };
    walk(body);
    for (const path of referenced) {
      expect(existsSync(resolve(path)), `${path} is referenced but does not exist`).toBe(true);
      expect(statSync(resolve(path)).size, `${path} is referenced but empty`).toBeGreaterThan(0);
    }
  });

  it.each(receipts)("$file either carries a real screenshot or says why not", ({ body }) => {
    if (body.screenshot === null) {
      // Absence must be declared and explained, never left blank.
      expect(body.screenshotStatus).toBe("not_persisted");
      expect(typeof body.screenshotWhy).toBe("string");
      expect((body.screenshotWhy ?? "").length).toBeGreaterThan(80);
      return;
    }
    expect(body.screenshotStatus).toBe("persisted");

    const verifyImage = (
      imagePath: string,
      claimedSha256: string | undefined,
      claimedDimensions: { width: number; height: number } | undefined,
    ): void => {
      const path = resolve(imagePath);
      expect(existsSync(path), `${imagePath} is claimed but missing`).toBe(true);
      const bytes = readFileSync(path);
      expect(claimedSha256, "a persisted screenshot must publish its hash").toBeTruthy();
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(claimedSha256);
      const size = imageSize(bytes);
      expect(size, "the screenshot must be a readable PNG or JPEG").not.toBeNull();
      expect(claimedDimensions).toEqual(size);
    };

    verifyImage(body.screenshot, body.screenshotSha256, body.screenshotDimensions);
    for (const supplemental of body.supplementalScreenshots ?? []) {
      verifyImage(supplemental.path, supplemental.sha256, supplemental.dimensions);
    }
  });

  it.each(receipts)("$file records a sanitized request audit with no secret", ({ body }) => {
    const audit = body.requestAudit;
    expect(audit, "every authenticated receipt must carry a request audit").toBeTruthy();
    expect(audit!.byMethodUrlClassStatus.length).toBeGreaterThan(0);
    // Grouped by method, URL class, status and count.
    for (const row of audit!.byMethodUrlClassStatus) {
      expect(typeof row.method).toBe("string");
      expect(typeof row.urlClass).toBe("string");
      expect(typeof row.count).toBe("number");
      expect(row.count).toBeGreaterThan(0);
    }
    // The counts must actually add up to the declared total.
    const summed = audit!.byMethodUrlClassStatus.reduce((s, r) => s + r.count, 0);
    expect(summed).toBe(audit!.totalRequestsObserved);
    // Read-only law.
    expect(audit!.mutatingApplicationRequests).toBe(0);
    expect(Object.keys(audit!.methodsObserved)).toEqual(["GET"]);
    // Nothing secret anywhere in the receipt.
    const raw = JSON.stringify(body);
    for (const forbidden of [
      /set-cookie/i, /authorization:/i, /bearer\s+[\w-]{12,}/i,
      /postgres(ql)?:\/\//i, /\baccess_token\b/i, /session=/i,
      /[?&](token|key|secret|password)=/i,
    ]) {
      expect(raw, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("keeps the static harness from ever satisfying the authenticated gate", () => {
    const dir = resolve("playwright/.evidence/d084-budget-evidence");
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const body = JSON.parse(readFileSync(resolve(dir, file), "utf8")) as Record<string, unknown>;
      expect(body.receiptKind).toBe("static_component_harness");
      expect(body.satisfiesAuthenticatedSurfaceGate).toBe(false);
    }
  });

  it("records the mobile 390 gate as PASS on the authenticated surface", () => {
    const mobile = receipts.find((r) => r.file.includes("mobile-390"))!.body;
    expect(mobile.receiptKind).toBe("authenticated_decision_center");
    expect(mobile.verdict).toBe("PASS");
    expect(mobile.measuredViewport).toEqual({ innerWidth: 390, innerHeight: 844 });
    expect(mobile.occupiedColumnCount).toBe(1);
    expect(mobile.stacked).toBe(true);
    expect(mobile.overlap).toBe(false);
    expect(mobile.bothVisible).toBe(true);
    expect(mobile.visibleInMobileStage).toBe(2);
    expect(mobile.enabledWriteControls).toBe(0);
    expect(mobile.budgetPanelCtaAllDisabled).toBe(true);
    expect((mobile.horizontalOverflow as { overflows: boolean }).overflows).toBe(false);
  });

  it("keeps desktop and mobile on the same served contracts and canonical values", () => {
    const desktop = receipts.find((r) => r.file.includes("desktop-1440"))!.body;
    const mobile = receipts.find((r) => r.file.includes("mobile-390"))!.body;
    expect(mobile.servedContractVersions).toEqual(desktop.servedContractVersions);
    expect(mobile.directionToActionFromServer).toEqual(desktop.directionToActionFromServer);
    expect(mobile.canonical).toEqual(desktop.canonical);
    expect(desktop.verdict).toBe("PASS");
  });
});

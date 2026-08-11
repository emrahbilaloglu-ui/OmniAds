import { describe, expect, it } from "vitest";

import {
  BACKEND_CAP_NOT_SUPPLIED,
  LANDING_PAGE_PAGE_SIZE,
  LANDING_PAGE_ROW_CAP,
  PUBLIC_SHARE_GONE,
  canCreateBrief,
  landingPageCap,
  rotationInvalidates,
  shareStatus,
  sourceState,
  toBriefRow,
  toShareRow,
} from "@/lib/zero-base/creative/studio-adapters";
import {
  BUYER_ACKNOWLEDGEMENT_VALUE,
  BUYER_FINANCIAL_WARNING,
  requireShareAcknowledgement,
} from "@/lib/zero-base/creative/share-acknowledgement";

const NOW = new Date("2026-08-11T12:00:00.000Z");

describe("landing-page cap semantics", () => {
  it("prints the served caps exactly", () => {
    const cap = landingPageCap({ rowCap: LANDING_PAGE_ROW_CAP, pageSize: LANDING_PAGE_PAGE_SIZE });
    expect(cap.rowCap).toBe(250);
    expect(cap.pageSize).toBe(100);
    expect(cap.text).toBe("Up to 250 rows, 100 per page.");
  });

  it("says the backend supplied no cap rather than printing one from the spec", () => {
    // 250/100 are only true if the server enforces them; printing them here
    // would be a limit the operator plans around and nobody applies.
    const cap = landingPageCap({});
    expect(cap.rowCap).toBeNull();
    expect(cap.pageSize).toBeNull();
    expect(cap.text).toBe(BACKEND_CAP_NOT_SUPPLIED);
    expect(cap.text).not.toMatch(/250|100/);
  });

  it("treats null and non-integer caps as not supplied", () => {
    expect(landingPageCap({ rowCap: null, pageSize: undefined }).text).toBe(BACKEND_CAP_NOT_SUPPLIED);
    expect(landingPageCap({ rowCap: 12.5 as number }).text).toBe(BACKEND_CAP_NOT_SUPPLIED);
  });

  it("reports a partial cap without inventing the missing half", () => {
    expect(landingPageCap({ rowCap: 250 }).text).toBe("Up to 250 rows.");
    expect(landingPageCap({ pageSize: 100 }).text).toBe("100 per page.");
  });
});

describe("briefs are lineage-safe and undeletable", () => {
  it("refuses creation without both creative and account identity", () => {
    expect(canCreateBrief({ creativeId: null, accountId: "act_1" }).ok).toBe(false);
    expect(canCreateBrief({ creativeId: "cr-1", accountId: "  " }).ok).toBe(false);
    expect(canCreateBrief({ creativeId: "cr-1", accountId: "act_1" }).ok).toBe(true);
  });

  it("discloses a brief whose origin was never recorded", () => {
    const row = toBriefRow({ id: "b1", title: "Brief", createdAt: "t" });
    expect(row.lineage.known).toBe(false);
    expect(!row.lineage.known && row.lineage.reason).toMatch(/does not record the creative/);
  });

  it("keeps a recorded lineage intact", () => {
    const row = toBriefRow({
      id: "b1",
      title: "Brief",
      createdAt: "t",
      sourceCreativeId: "cr-1",
      sourceAccountId: "act_1",
    });
    expect(row.lineage).toEqual({ known: true, creativeId: "cr-1", accountId: "act_1" });
  });

  it("says the status was not reported rather than guessing one", () => {
    expect(toBriefRow({ id: "b1", title: "t", createdAt: "t" }).status).toBe("Not reported");
  });
});

describe("source states", () => {
  it("marks an unsourced row rather than leaving it blank", () => {
    expect(sourceState(null).kind).toBe("unsourced");
    expect(sourceState("   ").kind).toBe("unsourced");
    expect(sourceState("meta_ad_library")).toEqual({ kind: "sourced", source: "meta_ad_library" });
  });
});

describe("share ledger status", () => {
  const base = {
    token: "t1",
    title: "Q3 creatives",
    audience: "buyer" as const,
    createdAt: "2026-08-01",
    expiresAt: "2026-08-20",
  };

  it("separates revoked from expired for the owner", () => {
    expect(shareStatus(base, NOW)).toBe("active");
    expect(shareStatus({ ...base, expiresAt: "2026-08-01" }, NOW)).toBe("expired");
    expect(shareStatus({ ...base, revokedAt: "2026-08-05" }, NOW)).toBe("revoked");
  });

  it("treats an unparseable expiry as expired rather than active", () => {
    expect(shareStatus({ ...base, expiresAt: "soon" }, NOW)).toBe("expired");
  });

  it("offers actions only on an active share", () => {
    expect(toShareRow(base, NOW).status).toBe("active");
    expect(toShareRow({ ...base, revokedAt: "x" }, NOW).statusText).toBe("Revoked");
  });

  it("tells a public visitor nothing about which of the three happened", () => {
    // Distinguishing them confirms to an outsider that the link was once real
    // and that this workspace issued it.
    expect(PUBLIC_SHARE_GONE).toMatch(/expired, been withdrawn, or never existed/);
    expect(PUBLIC_SHARE_GONE).not.toMatch(/revoked by|this business|workspace/i);
  });

  it("names the token rotation invalidates", () => {
    expect(rotationInvalidates({ oldToken: "old", newToken: "new" })).toEqual({
      invalidated: "old",
      issued: "new",
    });
  });
});

describe("buyer financial-warning acknowledgement", () => {
  it("requires the exact value for a buyer share", () => {
    const result = requireShareAcknowledgement({ audience: "buyer", acknowledgement: undefined });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("financial_acknowledgement_required");
  });

  it("refuses truthy stand-ins, which mean nobody read what it attests to", () => {
    for (const value of [true, 1, "yes", "true", {}]) {
      expect(requireShareAcknowledgement({ audience: "buyer", acknowledgement: value }).ok).toBe(false);
    }
  });

  it("accepts the exact acknowledgement", () => {
    expect(
      requireShareAcknowledgement({ audience: "buyer", acknowledgement: BUYER_ACKNOWLEDGEMENT_VALUE }).ok,
    ).toBe(true);
  });

  it("leaves creator shares unchanged", () => {
    expect(requireShareAcknowledgement({ audience: "creator", acknowledgement: undefined }).ok).toBe(true);
  });

  it("states what the sender is acknowledging, in full", () => {
    expect(BUYER_FINANCIAL_WARNING).toMatch(/attribution-window dependent/);
    expect(BUYER_FINANCIAL_WARNING).toMatch(/not\s+accounting revenue/);
  });
});

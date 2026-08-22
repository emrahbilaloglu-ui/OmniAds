import { describe, expect, it } from "vitest";

import {
  BACKEND_CAP_NOT_SUPPLIED,
  LANDING_PAGE_PAGE_SIZE,
  LANDING_PAGE_ROW_CAP,
  PUBLIC_SHARE_GONE,
  buildCreateBriefRequest,
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
  const SNAPSHOT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const full = { creativeId: "cr-1", accountId: "act_1", snapshotId: SNAPSHOT, trigger: "manual" };

  it("refuses creation without both creative and account identity", () => {
    expect(canCreateBrief({ ...full, creativeId: null }).ok).toBe(false);
    expect(canCreateBrief({ ...full, accountId: "  " }).ok).toBe(false);
    expect(canCreateBrief(full).ok).toBe(true);
  });

  it("refuses before POST when no decision snapshot is in scope", () => {
    // The route's lineage is a decision snapshot, not merely a creative id;
    // posting without one earns a 400 the operator cannot act on.
    const gate = canCreateBrief({ ...full, snapshotId: null });
    expect(gate.ok).toBe(false);
    expect(!gate.ok && gate.reason).toMatch(/derived from a decision snapshot/);
  });

  it("refuses a snapshot id the route would reject as non-UUID", () => {
    expect(canCreateBrief({ ...full, snapshotId: "not-a-uuid" }).ok).toBe(false);
  });

  it("refuses when the snapshot records no trigger", () => {
    expect(canCreateBrief({ ...full, trigger: null }).ok).toBe(false);
  });

  it("builds the exact body the route parses", () => {
    const body = buildCreateBriefRequest({
      lineage: full,
      content: { keep: " k ", change: "c", next: "n" },
      idempotencyKey: "idem-1",
    });
    expect(body.sourceDecision).toEqual({ snapshotId: SNAPSHOT, trigger: "manual" });
    expect(body.providerAccountId).toBe("act_1");
    expect(body.idempotencyKey).toBe("idem-1");
    expect(body.content.keep).toBe("k");
  });

  it("reads lineage from the served sourceDecision, not from fields nobody sends", () => {
    /**
     * `MetaCreativeBrief` carries `providerAccountId` and a `sourceDecision`
     * holding `creativeId`. The adapter used to look for flat
     * `sourceCreativeId` / `sourceAccountId` fields the endpoint has never
     * sent, so EVERY brief reported "does not record the creative it was
     * derived from" — about briefs whose creative id was in the payload. Plan
     * §5.1 finding 17.
     */
    const row = toBriefRow({
      id: "b1",
      createdAt: "t",
      providerAccountId: "act_1",
      sourceDecision: {
        creativeId: "cr_9",
        snapshotId: "snap_1",
        publishedLabel: "Cut — below break-even",
      },
      content: { keep: "k", change: "c", next: "n" },
      status: "draft",
    });
    expect(row.lineage.known).toBe(true);
    expect(row.lineage.known && row.lineage.creativeId).toBe("cr_9");
    expect(row.lineage.known && row.lineage.accountId).toBe("act_1");
    // The title comes from the decision's own published label — the verdict the
    // brief was written about — because the served contract has no title field.
    expect(row.title).toBe("Cut — below break-even");
    expect(row.status).toBe("draft");
  });

  it("does not use the id as a name when no label was served", () => {
    // An id is an identifier. Printing one where a name goes is how a UUID ends
    // up looking like a title.
    const row = toBriefRow({ id: "b1", createdAt: "t" });
    expect(row.title).toBe("Untitled brief");
    expect(row.title).not.toContain("b1");
  });

  it("still reads an older flat payload rather than throwing", () => {
    const row = toBriefRow({
      id: "b1",
      title: "Legacy brief",
      createdAt: "t",
      sourceCreativeId: "cr_legacy",
      sourceAccountId: "act_legacy",
    });
    expect(row.title).toBe("Legacy brief");
    expect(row.lineage.known).toBe(true);
  });

  it("discloses a brief whose origin was never recorded", () => {
    const row = toBriefRow({ id: "b1", createdAt: "t" });
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

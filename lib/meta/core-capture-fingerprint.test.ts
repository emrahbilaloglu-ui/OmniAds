import { describe, expect, it } from "vitest";
import { buildMetaCoreCaptureFingerprint, recordMetaAdPageSourceSnapshots, isMetaCoreCaptureReplayProof,
  type MetaCorePageEvidence } from
  "./core-capture-fingerprint";
import type { MetaAccountDailyRow, MetaAdDailyRow,
  MetaCampaignDailyRow } from "./warehouse-types";

const fields = "ad_id,spend,actions";
const pages: MetaCorePageEvidence[] = [
  { pageIndex: 0, snapshotId: "page-0", rowCount: 1, hasNext: true,
    providerHttpStatus: 200, status: "fetched", requestFields: fields },
  { pageIndex: 1, snapshotId: "page-1", rowCount: 1, hasNext: false,
    providerHttpStatus: 200, status: "fetched", requestFields: fields },
];
const rows = [{ businessId: "business", providerAccountId: "act_1",
  date: "2026-09-20", adId: "ad-1", sourceRunId: "run-1",
  sourceSnapshotId: "page-1", spend: 10, conversions: 0,
  payloadJson: { actions: [] }, finalizedAt: "2026-09-21T10:00:00Z" }] as unknown as
  MetaAdDailyRow[];
const accountRows = [{ businessId: "business", providerAccountId: "act_1",
  date: "2026-09-20", accountName: "Account", sourceRunId: "run-1",
  sourceSnapshotId: "page-1" }] as unknown as MetaAccountDailyRow[];
const campaignRows = [{ businessId: "business", providerAccountId: "act_1",
  date: "2026-09-20", campaignId: "campaign-1", objective: "SALES",
  sourceRunId: "run-1", sourceSnapshotId: "page-1" }] as unknown as
  MetaCampaignDailyRow[];
const input = { businessId: "business", providerAccountId: "act_1",
  day: "2026-09-20", sourceRunId: "run-1", requestFields: fields,
  pages, rowsFetchedTotal: 2, accountRows, campaignRows, adsetRows: [],
  adRows: rows };

describe("complete Meta core capture fingerprint", () => {
  it("refuses partial, legacy, foreign or internally inconsistent persisted replay proof",()=>{
    const scope={businessId:input.businessId,providerAccountId:input.providerAccountId,
      day:input.day,sourceRunId:input.sourceRunId};
    const core=buildMetaCoreCaptureFingerprint(input)!;
    expect(isMetaCoreCaptureReplayProof(core,scope)).toBe(true);
    for(const bad of [null,{}, {...core,version:"meta-core-capture.v2"},
      {...core,replayContent:{}}, {...core,rowsFetchedTotal:3},
      {...core,pages:[{...pages[0]!,hasNext:false},pages[1]!] },
      {...core,replayContent:{...core.replayContent,surfaceFactFingerprints:{}}},
      {...core,surfaceFactFingerprints:{}},
      {...core,businessId:"other"}]) expect(isMetaCoreCaptureReplayProof(bad,scope)).toBe(false);
  });
  it("attributes Ads to their actual page and refuses duplicate-ID attribution", () => {
    const sourceByAdId = new Map<string, string | null>();
    recordMetaAdPageSourceSnapshots(sourceByAdId,
      [{ ad_id: "ad-first" }], "page-0");
    recordMetaAdPageSourceSnapshots(sourceByAdId,
      [{ ad_id: "ad-last" }], "page-1");
    expect(sourceByAdId.get("ad-first")).toBe("page-0");
    expect(sourceByAdId.get("ad-last")).toBe("page-1");
    const splitPageCapture = buildMetaCoreCaptureFingerprint({ ...input,
      adRows: [{ ...rows[0]!, adId: "ad-first",
        sourceSnapshotId: sourceByAdId.get("ad-first") ?? null }] });
    expect(splitPageCapture).not.toBeNull();
    recordMetaAdPageSourceSnapshots(sourceByAdId,
      [{ ad_id: "ad-first" }], "page-1");
    expect(sourceByAdId.get("ad-first")).toBeNull();
    expect(buildMetaCoreCaptureFingerprint({ ...input,
      adRows: [{ ...rows[0]!, adId: "ad-first",
        sourceSnapshotId: sourceByAdId.get("ad-first") ?? null }] })).toBeNull();
  });

  it("ignores write clocks but changes for same-spend action restatement", () => {
    const first = buildMetaCoreCaptureFingerprint(input);
    const newClock = buildMetaCoreCaptureFingerprint({ ...input,
      adRows: [{ ...rows[0]!, finalizedAt: "2026-09-22T10:00:00Z" }],
      campaignRows: [{ ...campaignRows[0]!,
        configObservedAt: "2026-09-22T10:00:00Z" }] });
    const actionChanged = buildMetaCoreCaptureFingerprint({ ...input,
      adRows: [{ ...rows[0]!, payloadJson: { actions: [
        { action_type: "purchase", value: "1" }] } }] });
    expect(first).not.toBeNull();
    expect(newClock).toEqual(first);
    expect(actionChanged?.surfaceFactFingerprints.ad_daily)
      .not.toBe(first?.surfaceFactFingerprints.ad_daily);
  });

  it("changes when a campaign decision fact changes without spend drift", () => {
    const oldCapture = buildMetaCoreCaptureFingerprint(input);
    const changed = buildMetaCoreCaptureFingerprint({ ...input,
      campaignRows: [{ ...campaignRows[0]!, objective: "LEADS" }] });
    expect(changed?.surfaceFactFingerprints.campaign_daily)
      .not.toBe(oldCapture?.surfaceFactFingerprints.campaign_daily);
  });

  it("binds all raw pages and facts while separating a new observation run", () => {
    const original = buildMetaCoreCaptureFingerprint(input)!;
    const observed = buildMetaCoreCaptureFingerprint({ ...input, sourceRunId: "run-2",
      accountRows: accountRows.map((row) => ({ ...row, sourceRunId: "run-2" })),
      campaignRows: campaignRows.map((row) => ({ ...row, sourceRunId: "run-2" })),
      adRows: rows.map((row) => ({ ...row, sourceRunId: "run-2" })),
    })!;
    expect(observed.sourceRunId).not.toBe(original.sourceRunId);
    expect(observed.surfaceFactFingerprints).not.toEqual(original.surfaceFactFingerprints);
    expect(observed.replayContent).toEqual(original.replayContent);
    const sourceChanged = buildMetaCoreCaptureFingerprint({ ...input,
      pages: pages.map((page) => ({ ...page, snapshotId: `${page.snapshotId}-new` })),
      accountRows: accountRows.map((row) => ({ ...row, sourceSnapshotId: "page-1-new" })),
      campaignRows: campaignRows.map((row) => ({ ...row, sourceSnapshotId: "page-1-new" })),
      adRows: rows.map((row) => ({ ...row, sourceSnapshotId: "page-1-new" })),
    })!;
    expect(sourceChanged.replayContent).not.toEqual(original.replayContent);
    expect(buildMetaCoreCaptureFingerprint({ ...input,
      campaignRows: [{ ...campaignRows[0]!, objective: "LEADS" }],
    })!.replayContent).not.toEqual(original.replayContent);
    expect(buildMetaCoreCaptureFingerprint({ ...input,
      adRows: [{ ...rows[0]!, payloadJson: { actions: [{ action_type: "purchase", value: "1" }] } }],
    })!.replayContent).not.toEqual(original.replayContent);
  });

  it("rejects missing actions, a broken pagination chain and page reordering", () => {
    expect(buildMetaCoreCaptureFingerprint({ ...input,
      requestFields: "ad_id,spend" })).toBeNull();
    expect(buildMetaCoreCaptureFingerprint({ ...input,
      pages: [pages[0]!, { ...pages[1]!, hasNext: true }] })).toBeNull();
    expect(buildMetaCoreCaptureFingerprint({ ...input,
      pages: [pages[1]!, pages[0]!] })).toBeNull();
    expect(buildMetaCoreCaptureFingerprint({ ...input,
      pages: [{ ...pages[0]!, snapshotId: "page-1" },
        { ...pages[1]!, snapshotId: "page-0" }] }))
      .not.toEqual(buildMetaCoreCaptureFingerprint(input));
  });
});

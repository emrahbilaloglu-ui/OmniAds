import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
}));
vi.mock("@/lib/notification-store", () => ({
  recordNotificationEvent: vi.fn(async () => ({ created: true, record: null })),
}));

import * as db from "@/lib/db";
import { recordNotificationEvent } from "@/lib/notification-store";
import { produceNotificationsForBusiness } from "@/lib/notification-producer";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const RECIPIENT = "22222222-2222-4222-8222-222222222222";
const DAY = "2026-09-06";
const reads: Array<{ text: string; params: unknown[] }> = [];

function anomaly(scopeType: "campaign" | "adset" | "account", scopeId: string) {
  return {
    snapshot_date: DAY,
    rec_id: `anomaly-${scopeId}`,
    rec_type: "zero_conversions_with_spend",
    scope_type: scopeType,
    scope_id: scopeId,
    severity: "high",
    evidence: { anomaly: { scopeLabel: scopeId } },
    recommended_action: "Review",
    reasoning: "Detected.",
    diagnostics: [],
    detected_at: `${DAY}T09:00:00.000Z`,
    resolved_at: null,
  };
}

const rows = [
  anomaly("campaign", "cmp_1"), anomaly("adset", "set_1"), anomaly("account", "act_1"),
  anomaly("campaign", "cmp_2"), anomaly("adset", "set_2"), anomaly("account", "act_2"),
];

beforeEach(() => {
  vi.clearAllMocks();
  reads.length = 0;
  // Run the real anomaly reader and its account filter. Only storage is faked;
  // the producer must not stamp an account onto an unfiltered sibling row.
  const sql = async (parts: TemplateStringsArray, ...params: unknown[]) => {
    const text = parts.join("?");
    reads.push({ text, params });
    if (text.includes("MAX(snapshot_date)")) return [{ snapshot_date: DAY }];
    if (text.includes("FROM meta_decision_snapshots_daily")) return rows;
    if (text.includes("FROM meta_campaign_dimensions")) {
      return [{ campaign_id: params[1] === "act_1" ? "cmp_1" : "cmp_2" }];
    }
    if (text.includes("FROM meta_adset_dimensions")) {
      return [{ adset_id: params[1] === "act_1" ? "set_1" : "set_2" }];
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  vi.mocked(db.getDb).mockReturnValue(sql as unknown as ReturnType<typeof db.getDb>);
});

async function produce(providerAccountId?: string | null) {
  return produceNotificationsForBusiness({
    businessId: BUSINESS,
    providerAccountId,
    recipientUserId: RECIPIENT,
    now: new Date(`${DAY}T10:00:00.000Z`),
  });
}

describe("notification account attribution matches the anomaly read", () => {
  it.each(["act_1", "  act_1  "])("filters siblings before stamping %s", async (account) => {
    const result = await produce(account);
    const events = vi.mocked(recordNotificationEvent).mock.calls.map(([input]) => input.event);

    expect(result).toMatchObject({ scanned: 3, created: 3, failed: 0 });
    expect(events.map((event) => event.entityId)).toEqual(["cmp_1", "set_1", "act_1"]);
    expect(events.every((event) => event.providerAccountId === "act_1")).toBe(true);
    expect(events.every((event) => event.occurredOn === DAY)).toBe(true);
    expect(reads.find((read) => read.text.includes("MAX(snapshot_date)"))?.params)
      .toEqual([BUSINESS, DAY, DAY]);
  });

  it.each([undefined, null, "   "])("keeps an unnamed account business-wide and unlabelled (%s)", async (account) => {
    const result = await produce(account);
    const events = vi.mocked(recordNotificationEvent).mock.calls.map(([input]) => input.event);

    expect(result).toMatchObject({ scanned: 6, created: 6, failed: 0 });
    expect(events.every((event) => event.providerAccountId === null)).toBe(true);
    expect(reads.some((read) => read.text.includes("_dimensions"))).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTOMATIC_CAMPAIGN_ROLES,
  resolveCampaignRoleAuthority,
} from "@/lib/meta/campaign-role-authority";
import { META_CAMPAIGN_KINDS } from "@/lib/meta/campaign-label-types";
import type {
  CampaignKind,
  ContextConfidenceClass,
} from "../../campaign-context/resolver";

/**
 * A withdrawn role must STOP authorising, and only a row can do that.
 *
 * The producer wrote an authority record on resolved days only, so the day the
 * resolver withdrew a role it wrote nothing at all. Both budget source readers
 * take this campaign's rows `ORDER BY as_of_date DESC, recorded_at DESC LIMIT
 * 25` and hand them to `resolveCampaignRoleAuthority` with
 * `maxEvidenceAgeDays: 60`, never joining the current context row — so silence
 * left the older high-confidence row newest, and it kept authorising provider
 * writes for up to 60 days under a role that no longer held.
 *
 * These cases run the real job against a recording database and then judge what
 * it wrote with the real reader, so the two halves cannot drift: a change that
 * stops writing the tombstone fails here, and so does a tombstone shaped in a
 * way the reader would accept.
 */

const AS_OF_RESOLVED = "2026-09-01";
// Far enough after the resolved day that the producer's own 7-day hysteresis
// lookback finds nothing — the realistic shape of a producer outage, and the
// one sequence where a `high` row is the newest thing standing when the
// resolver next speaks and has nothing to say.
const AS_OF_WITHDRAWN = "2026-09-12";
const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ACCOUNT_ID = "act_1234567890";
const CAMPAIGN_ID = "23851234567890123";

interface RecordedQuery {
  sql: string;
  params: readonly unknown[];
}

const recorded: RecordedQuery[] = [];

let scriptedResolution: {
  kind: CampaignKind | null;
  confidenceClass: ContextConfidenceClass;
} = { kind: "main", confidenceClass: "high" };

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    query: async (sql: string, params: readonly unknown[] = []) => {
      recorded.push({ sql, params });
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return [{ acquired: true }];
      }
      if (sql.includes("INSERT INTO engine_v3_job_runs")) {
        return [{ id: "22222222-2222-4222-8222-222222222222" }];
      }
      // The producer's own previous-state read. Empty is what it returns when
      // the last run is outside its 7-day lookback.
      if (sql.includes("SELECT DISTINCT ON")) return [];
      return [];
    },
  }),
  runDbTransaction: async <T,>(fn: () => Promise<T>) => fn(),
}));

vi.mock("../../jobs/business-guard", () => ({
  getBusinessGuardFailure: async () => null,
}));

vi.mock("../../feature-flags", () => ({
  resolveEngineV3Flags: async () => ({ enabled: true }),
}));

vi.mock("../../campaign-context/data", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../campaign-context/data")>();
  return {
    ...actual,
    readCampaignContextCreativeDays: async () => [
      { providerAccountId: PROVIDER_ACCOUNT_ID, campaignId: CAMPAIGN_ID },
    ],
    readCampaignContextCampaignMeta: async () => [],
    computeCampaignLineage: () => ({}),
    buildCampaignContextFeatures: () => [
      // Name-neutral: a null name keeps family inheritance out of the picture,
      // so the published kind is the scripted resolution and nothing else.
      { campaignId: CAMPAIGN_ID, campaignName: null },
    ],
  };
});

vi.mock("../../campaign-context/resolver", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../campaign-context/resolver")>();
  return {
    ...actual,
    classifyCampaignContext: () => ({
      campaignId: CAMPAIGN_ID,
      campaignName: null,
      kind: scriptedResolution.kind,
      kindSource: "system_inferred",
      confidenceClass: scriptedResolution.confidenceClass,
      confidenceScore: 0.9,
      testScore: 0.1,
      mainScore: 0.9,
      mixedScore: 0,
      agreeingFamilies: [],
      conflictReasons: [],
      evidence: ["scripted"],
      resolverVersion: actual.CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    }),
  };
});

const { CAMPAIGN_CONTEXT_RESOLVER_VERSION } = await import(
  "../../campaign-context/resolver"
);
const {
  CAMPAIGN_ROLE_AUTHORITY_UNRESOLVED_KIND,
  runCampaignContextJob,
  UPSERT_ROLE_AUTHORITY_QUERY,
} = await import("../../jobs/campaign-context-job");

/** The authority rows the job actually wrote, in the order it wrote them. */
function authorityRowsWritten() {
  return recorded
    .filter((entry) => entry.sql === UPSERT_ROLE_AUTHORITY_QUERY)
    .map((entry) => ({
      businessId: String(entry.params[1]),
      providerAccountId: String(entry.params[2]),
      campaignId: String(entry.params[3]),
      asOfDate: String(entry.params[4]),
      inferredKind: String(entry.params[5]),
      resolverVersion: String(entry.params[6]),
      confidenceClass: String(entry.params[7]),
      // The statement writes the source as a literal, so it is one here too.
      kindSource: "system_inferred",
    }));
}

/** Exactly the call both frozen budget readers make over these rows. */
function readerVerdict(
  rows: ReturnType<typeof authorityRowsWritten>,
  asOfDate: string,
) {
  return resolveCampaignRoleAuthority({
    request: {
      businessId: BUSINESS_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      campaignId: CAMPAIGN_ID,
      asOfDate,
      maxEvidenceAgeDays: 60,
    },
    evidence: rows,
    identities: [
      {
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        campaignId: CAMPAIGN_ID,
        observedOn: AS_OF_RESOLVED,
      },
    ],
    // Mirrors production's approved state without depending on the env var.
    isResolverVersionValidated: (version) =>
      version === CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  });
}

async function runResolvedDayThenWithdrawnDay() {
  scriptedResolution = { kind: "main", confidenceClass: "high" };
  await runCampaignContextJob({
    businessId: BUSINESS_ID,
    asOf: AS_OF_RESOLVED,
  });
  scriptedResolution = { kind: null, confidenceClass: "unknown" };
  await runCampaignContextJob({
    businessId: BUSINESS_ID,
    asOf: AS_OF_WITHDRAWN,
  });
}

describe("campaign role authority withdrawal", () => {
  beforeEach(() => {
    recorded.length = 0;
  });

  it("records the unresolved day instead of leaving the older role newest", async () => {
    await runResolvedDayThenWithdrawnDay();
    const rows = authorityRowsWritten();

    expect(rows.map((row) => row.asOfDate)).toEqual([
      AS_OF_RESOLVED,
      AS_OF_WITHDRAWN,
    ]);
    expect(rows[0]).toMatchObject({
      inferredKind: "main",
      confidenceClass: "high",
    });
    expect(rows[1]).toMatchObject({
      inferredKind: CAMPAIGN_ROLE_AUTHORITY_UNRESOLVED_KIND,
    });
    // A null kind never publishes `high`, so the tombstone cannot carry the one
    // class the readers require even before its kind is examined.
    expect(rows[1].confidenceClass).not.toBe("high");
  });

  it("withdraws authority the readers would otherwise grant for 60 days", async () => {
    await runResolvedDayThenWithdrawnDay();
    const rows = authorityRowsWritten();

    // The resolved day alone — what the readers saw before the tombstone
    // existed — really does still authorise, which is the defect being closed.
    const withoutWithdrawal = readerVerdict([rows[0]], AS_OF_WITHDRAWN);
    expect(withoutWithdrawal.satisfiesRoleAuthority).toBe(true);
    expect(withoutWithdrawal.role).toBe("main");

    const verdict = readerVerdict(rows, AS_OF_WITHDRAWN);
    expect(verdict.satisfiesRoleAuthority).toBe(false);
    expect(verdict.role).toBeNull();
    expect(verdict.blockers).toContain("role_kind_unrecognised");
    // Still denied at the far edge of the 60-day window, not merely aged out.
    expect(readerVerdict(rows, "2026-10-25").satisfiesRoleAuthority).toBe(false);
  });

  it("keeps the tombstone out of every role allow-list", () => {
    // The tombstone denies because neither reader's allow-list contains it.
    // Adding it to either would silently turn the withdrawal into an answer.
    expect(AUTOMATIC_CAMPAIGN_ROLES as readonly string[]).not.toContain(
      CAMPAIGN_ROLE_AUTHORITY_UNRESOLVED_KIND,
    );
    expect(META_CAMPAIGN_KINDS as readonly string[]).not.toContain(
      CAMPAIGN_ROLE_AUTHORITY_UNRESOLVED_KIND,
    );
  });
});

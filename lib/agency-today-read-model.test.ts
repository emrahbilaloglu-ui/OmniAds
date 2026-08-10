import { describe, expect, it } from "vitest";
import {
  buildAgencyTodayReadModel,
  type AgencyTodayClientInput,
} from "@/lib/agency-today-read-model";

function client(overrides: Partial<AgencyTodayClientInput> = {}): AgencyTodayClientInput {
  return {
    businessId: "biz-1",
    businessName: "Client One",
    currency: "USD",
    spend: 1000,
    revenue: 3000,
    dataHealth: "healthy",
    freshness: "fresh",
    ...overrides,
  };
}

describe("severity is decided by the server, not inferred from metrics", () => {
  it("treats a disconnected or action-required provider as critical", () => {
    const { rows } = buildAgencyTodayReadModel([
      client({ businessId: "a", dataHealth: "disconnected" }),
      client({ businessId: "b", dataHealth: "action_required" }),
    ]);
    expect(rows.every((row) => row.severity === "critical")).toBe(true);
    expect(rows[0].severityReasons.length).toBeGreaterThan(0);
  });

  it("treats policy incidents and critical anomalies as critical", () => {
    const [incident] = buildAgencyTodayReadModel([client({ policyIncidents: 2 })]).rows;
    expect(incident.severity).toBe("critical");
    expect(incident.severityReasons.join(" ")).toContain("2 delivery or policy incidents");

    const [anomaly] = buildAgencyTodayReadModel([client({ criticalAnomalies: 1 })]).rows;
    expect(anomaly.severity).toBe("critical");
    expect(anomaly.severityReasons.join(" ")).toContain("1 critical anomaly");
  });

  it("treats stale, degraded or pending work as attention rather than critical", () => {
    const [stale] = buildAgencyTodayReadModel([client({ freshness: "stale" })]).rows;
    expect(stale.severity).toBe("attention");

    const [pending] = buildAgencyTodayReadModel([client({ pendingDecisions: 3 })]).rows;
    expect(pending.severity).toBe("attention");
    expect(pending.severityReasons.join(" ")).toContain("3 decisions waiting");
  });

  it("marks a client with no exposure as unrankable rather than steady", () => {
    const [row] = buildAgencyTodayReadModel([client({ spend: null })]).rows;
    expect(row.severity).toBe("unknown");
    expect(row.severityReasons.join(" ")).toContain("Not enough data");
  });

  it("leaves a healthy, fresh, fully-ranked client steady with no noise", () => {
    const [row] = buildAgencyTodayReadModel([client()]).rows;
    expect(row.severity).toBe("steady");
    expect(row.severityReasons).toEqual([]);
  });
});

describe("ordering puts the right client first", () => {
  it("ranks critical above attention above steady", () => {
    const { rows } = buildAgencyTodayReadModel([
      client({ businessId: "steady", businessName: "Steady", spend: 9000 }),
      client({ businessId: "attention", businessName: "Attention", pendingDecisions: 1, spend: 10 }),
      client({ businessId: "critical", businessName: "Critical", policyIncidents: 1, spend: 5 }),
    ]);
    expect(rows.map((row) => row.businessId)).toEqual(["critical", "attention", "steady"]);
  });

  it("promotes an unrankable client above ranked peers in the same band", () => {
    const { rows } = buildAgencyTodayReadModel([
      client({ businessId: "ranked", pendingDecisions: 1, spend: 5000 }),
      client({ businessId: "unranked", pendingDecisions: 1, spend: null }),
    ]);
    expect(rows[0].businessId).toBe("unranked");
  });

  it("uses real money at stake as the tie-break inside a band", () => {
    const { rows } = buildAgencyTodayReadModel([
      client({ businessId: "small", spend: 100 }),
      client({ businessId: "large", spend: 8000 }),
    ]);
    expect(rows.map((row) => row.businessId)).toEqual(["large", "small"]);
  });

  it("stays stable between refreshes when spend ties", () => {
    const { rows } = buildAgencyTodayReadModel([
      client({ businessId: "b", businessName: "Beta", spend: 500 }),
      client({ businessId: "a", businessName: "Alpha", spend: 500 }),
    ]);
    expect(rows.map((row) => row.businessName)).toEqual(["Alpha", "Beta"]);
  });
});

describe("money is never blended across currencies", () => {
  it("produces a portfolio total when every client shares one currency", () => {
    const { portfolio } = buildAgencyTodayReadModel([
      client({ businessId: "a", currency: "USD", spend: 100, revenue: 300 }),
      client({ businessId: "b", currency: "usd", spend: 50, revenue: 100 }),
    ]);
    expect(portfolio.available).toBe(true);
    expect(portfolio.currency).toBe("USD");
    expect(portfolio.spend).toBe(150);
    expect(portfolio.revenue).toBe(400);
  });

  it("withholds the total when currencies differ", () => {
    const { portfolio } = buildAgencyTodayReadModel([
      client({ businessId: "a", currency: "USD" }),
      client({ businessId: "b", currency: "TRY" }),
    ]);
    expect(portfolio.available).toBe(false);
    expect(portfolio.withheldReason).toBe("mixed_currency");
    expect(portfolio.spend).toBeNull();
  });

  it("withholds the total when any client's currency is unknown", () => {
    const { portfolio } = buildAgencyTodayReadModel([
      client({ businessId: "a", currency: "USD" }),
      client({ businessId: "b", currency: null }),
    ]);
    expect(portfolio.available).toBe(false);
    expect(portfolio.withheldReason).toBe("unknown_currency");
  });

  it("refuses an invalid currency code rather than guessing", () => {
    const [row] = buildAgencyTodayReadModel([client({ currency: "$" })]).rows;
    expect(row.currency).toBeNull();
  });
});

describe("derived values stay honest", () => {
  it("does not derive ROAS from zero or missing spend", () => {
    expect(buildAgencyTodayReadModel([client({ spend: 0, revenue: 100 })]).rows[0].roas).toBeNull();
    expect(buildAgencyTodayReadModel([client({ spend: null })]).rows[0].roas).toBeNull();
    expect(
      buildAgencyTodayReadModel([client({ revenue: null })]).rows[0].roas,
    ).toBeNull();
  });

  it("derives ROAS when both sides are real", () => {
    expect(buildAgencyTodayReadModel([client({ spend: 1000, revenue: 2500 })]).rows[0].roas).toBe(2.5);
  });

  it("carries a scoped link so opening a client keeps its context", () => {
    const [row] = buildAgencyTodayReadModel([client({ businessId: "biz 7" })]).rows;
    expect(row.href).toContain(encodeURIComponent("biz 7"));
  });

  it("counts only the clients that need work", () => {
    const model = buildAgencyTodayReadModel([
      client({ businessId: "a" }),
      client({ businessId: "b", pendingDecisions: 1 }),
      client({ businessId: "c", policyIncidents: 1 }),
    ]);
    expect(model.clientCount).toBe(3);
    expect(model.needsAttentionCount).toBe(2);
  });

  it("returns an explicit empty portfolio for no clients", () => {
    const model = buildAgencyTodayReadModel([]);
    expect(model.rows).toEqual([]);
    expect(model.portfolio.withheldReason).toBe("no_clients");
    expect(model.portfolio.available).toBe(false);
  });
});

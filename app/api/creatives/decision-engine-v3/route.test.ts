import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  WarehouseDataSource,
  type DecisionResponse,
} from "@/lib/creative-decision-engine";
import { resolveDataSource } from "./data-source";
import { GET } from "./route";

const previousDataSourceFlag = process.env.DECISION_ENGINE_V3_DATA_SOURCE;

afterEach(() => {
  if (previousDataSourceFlag === undefined) {
    delete process.env.DECISION_ENGINE_V3_DATA_SOURCE;
  } else {
    process.env.DECISION_ENGINE_V3_DATA_SOURCE = previousDataSourceFlag;
  }
});

describe("GET /api/creatives/decision-engine-v3", () => {
  it("uses MockDataSource when DECISION_ENGINE_V3_DATA_SOURCE=mock", async () => {
    process.env.DECISION_ENGINE_V3_DATA_SOURCE = "mock";

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1&asOf=2026-05-04",
      ),
    );
    const payload = (await response.json()) as DecisionResponse;

    expect(response.status).toBe(200);
    expect(payload.dataSource).toBe("mock");
    expect(payload.dataHealth.worstTier).toBe("none");
    expect(payload.dataHealth.degraded).toBe(false);
    expect(payload.dataHealth.calibration).toBeDefined();
    expect(payload.dataHealth.lifecycle).toBeDefined();
    expect(payload.dataHealth.decisions).toBeDefined();
    expect(payload.decisions).toHaveLength(3);
  });

  it("defaults to WarehouseDataSource without an env override", () => {
    delete process.env.DECISION_ENGINE_V3_DATA_SOURCE;

    const resolved = resolveDataSource();

    expect(resolved.label).toBe("warehouse");
    expect(resolved.instance).toBeInstanceOf(WarehouseDataSource);
  });

  it("returns 400 when businessId is missing", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/creatives/decision-engine-v3"),
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("businessId required");
  });
});

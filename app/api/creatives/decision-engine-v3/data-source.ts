import {
  MockDataSource,
  WarehouseDataSource,
  type CreativeDecisionDataSource,
} from "@/lib/creative-decision-engine";

export type DecisionEngineV3DataSourceLabel = "warehouse" | "mock";

export function resolveDataSource(): {
  instance: CreativeDecisionDataSource;
  label: DecisionEngineV3DataSourceLabel;
} {
  const flag = (
    process.env.DECISION_ENGINE_V3_DATA_SOURCE ?? "warehouse"
  ).toLowerCase();
  if (flag === "mock") return { instance: new MockDataSource(), label: "mock" };
  return { instance: new WarehouseDataSource(), label: "warehouse" };
}

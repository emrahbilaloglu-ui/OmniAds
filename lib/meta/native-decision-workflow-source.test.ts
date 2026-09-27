import { beforeEach, describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({getDb: () => ({query})}));
import { verifyNativeDecisionWorkflowSource } from "./native-decision-workflow-source";
const sourceSnapshotId = "00000000-0000-4000-8000-000000000001";
const sourceEvaluationId = "10000000-0000-4000-8000-000000000001";
const input = {businessId:"biz-1",decisionKey:`native-ad:${sourceSnapshotId}:${sourceEvaluationId}`,sourceEvaluationId,sourceSnapshotId,providerAccountId:"act_1",entityId:"ad1",entityType:"ad"};
beforeEach(() => { query.mockReset(); });
describe("snapshot-bound operator feedback", () => {
  it("requires exact selected account, business, Ad and evaluation lineage", async () => {
    query.mockResolvedValue([{id:sourceSnapshotId}]);
    expect(await verifyNativeDecisionWorkflowSource(input)).toBe("verified");
    expect(query.mock.calls[0]?.[1]).toEqual(["biz-1","act_1","ad1",sourceSnapshotId,sourceEvaluationId]);
    expect(query.mock.calls[0]?.[0]).toContain("bpa.is_selected = TRUE");
    expect(query.mock.calls[0]?.[0]).toContain("e.ad_id = s.ad_id");
  });
  it.each([{sourceSnapshotId:"invalid"},{decisionKey:"native-ad:other"},{entityType:"creative"},{providerAccountId:undefined}])("refuses malformed bindings before reading", async change => {
    expect(await verifyNativeDecisionWorkflowSource({...input,...change})).toBe("mismatch");
    expect(query).not.toHaveBeenCalled();
  });
  it("refuses a missing or foreign snapshot and an unreadable source", async () => {
    query.mockResolvedValue([]);
    expect(await verifyNativeDecisionWorkflowSource(input)).toBe("mismatch");
    query.mockRejectedValue(Error("offline"));
    expect(await verifyNativeDecisionWorkflowSource(input)).toBe("unavailable");
  });
});

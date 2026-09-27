// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import { newWorkflowRecord } from "@/lib/decision-workflow";
import { NativeDecisionReviewPanel } from "./NativeDecisionReviewPanel";
import type { DecisionWorkflowOverlay } from "./use-decision-workflow";
afterEach(cleanup);
const decision = {
  identityGrain:"ad",providerAccountId:"act_1",parentChain:{ad:{id:"ad1"}},
  sourceAuthority:{snapshotId:"snapshot1",engineVersion:"epoch1",evaluationId:"evaluation1",inputHash:"input1",decisionHash:"decision1"},
  history:{providerWrites:{status:"unavailable"},outcomes:{status:"available",items:[]}},
} as unknown as MetaCanonicalDecision;
function overlay(overrides:Partial<DecisionWorkflowOverlay>={}):DecisionWorkflowOverlay {
  return {readState:"ready",unavailableReason:null,recordFor:()=>newWorkflowRecord({businessId:"biz1",decisionKey:"native-ad:snapshot1:evaluation1"}),
    submit:vi.fn(),lastMessage:null,conflict:null,dismissConflict:vi.fn(),pendingKey:null,...overrides};
}
describe("native operator feedback is separate from execution", () => {
  it("submits the exact snapshot and displayed version for acknowledgment", () => {
    const workflow=overlay();
    render(<NativeDecisionReviewPanel decision={decision} workflow={workflow} refusedReason={null}/>);
    fireEvent.click(screen.getByText("Acknowledge review"));
    expect(workflow.submit).toHaveBeenCalledWith("native-ad:snapshot1:evaluation1","acknowledge",expect.objectContaining({stateVersion:1}),{
      sourceEvaluationId:"evaluation1",sourceSnapshotId:"snapshot1",entityType:"ad",entityId:"ad1",providerAccountId:"act_1",
    });
    expect(screen.getByText(/Provider execution evidence/).textContent).toContain("not verified");
    expect(screen.getByText(/3-day outcome/).textContent).toContain("not observed");
  });
  it("requires a reason for disagreement and a future time for deferral", () => {
    const workflow=overlay();
    render(<NativeDecisionReviewPanel decision={decision} workflow={workflow} refusedReason={null}/>);
    fireEvent.click(screen.getByText("Disagree with decision"));
    fireEvent.click(screen.getByText("Defer review"));
    expect(workflow.submit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason for disagreeing"),{target:{value:"attribution_lag"}});
    fireEvent.click(screen.getByText("Disagree with decision"));
    expect(workflow.submit).toHaveBeenCalledWith(expect.any(String),"reject",expect.anything(),expect.objectContaining({reasonCode:"attribution_lag"}));
    fireEvent.change(screen.getByLabelText(/Defer review until/),{target:{value:"2099-01-01T12:00"}});
    fireEvent.click(screen.getByText("Defer review"));
    expect(workflow.submit).toHaveBeenLastCalledWith(expect.any(String),"snooze",expect.anything(),expect.objectContaining({snoozeUntil:expect.stringContaining("2099")}));
  });
  it.each(["reviewer", "pending", "unavailable"])("blocks writes for %s", state => {
    const workflow=overlay(state === "unavailable" ? {readState:"unavailable"} : state === "pending" ? {pendingKey:"native-ad:snapshot1:evaluation1"} : {});
    render(<NativeDecisionReviewPanel decision={decision} workflow={workflow} refusedReason={state === "reviewer" ? "Read only" : null}/>);
    fireEvent.click(screen.getByText("Acknowledge review"));
    expect(workflow.submit).not.toHaveBeenCalled();
    if(state === "unavailable") expect(screen.getByRole("status").textContent).toContain("unknown");
  });
});

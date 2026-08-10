import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MobileTier0Triage,
  MobileTier0TriagePanel,
  mobileTier0CompletionOutcome,
} from "@/components/meta/os/MobileTier0Triage";

/**
 * The permitted mobile task, and its telemetry.
 *
 * D5 keeps provider mutation on desktop, and nothing here writes to a provider.
 * But "no unsafe mutation" is not "no task": the phone job is to read a
 * decision, see its evidence and take ownership of it, and that either gets
 * finished or it does not. Without the two events the phone experience cannot
 * be judged at all, so D5 suppressing writes does not excuse missing telemetry.
 */
const source = readFileSync("components/meta/os/MobileTier0Triage.tsx", "utf8");

describe("the task is offered only where it can be done", () => {
  it("renders nothing on the server, which does not know the viewport", () => {
    // A phone-only task rendered server-side would flash on every desktop load.
    const html = renderToStaticMarkup(
      <MobileTier0Triage
        businessId="biz-1"
        decisionKey="dec-1"
        ownershipAvailable
      />,
    );
    expect(html).toBe("");
  });

  it("gates on a phone-width media query rather than a user agent", () => {
    expect(source).toContain("window.matchMedia(`(max-width: ${maxWidth}px)`)");
    expect(source).toContain("query.addEventListener(\"change\", apply)");
  });
});

describe("what the panel says at phone width", () => {
  it("offers the ownership controls when ownership can be recorded", () => {
    const html = renderToStaticMarkup(
      <MobileTier0TriagePanel ownershipAvailable>
        <button type="button">Take this on</button>
      </MobileTier0TriagePanel>,
    );
    expect(html).toContain('data-tier0-state="available"');
    expect(html).toContain('data-testid="mobile-tier0-controls"');
    expect(html).toContain("Take this on");
    // The desktop boundary is stated, not implied by an absent control.
    expect(html).toContain("Provider changes stay on desktop");
  });

  it("says why the task cannot be finished instead of showing a dead control", () => {
    const html = renderToStaticMarkup(
      <MobileTier0TriagePanel ownershipAvailable={false}>
        <button type="button">Take this on</button>
      </MobileTier0TriagePanel>,
    );
    expect(html).toContain('data-tier0-state="read_only"');
    expect(html).toContain("Ownership tracking is unavailable");
    // A disabled control with no explanation is worse than an absent one.
    expect(html).not.toContain("Take this on");
  });

  it("is labelled as its own region so a screen reader can reach it", () => {
    const html = renderToStaticMarkup(
      <MobileTier0TriagePanel ownershipAvailable />,
    );
    expect(html).toContain('aria-label="Triage this decision"');
  });
});

describe("the completion event tells the truth about the outcome", () => {
  it("reports an abandoned task as withheld, not as a completion", () => {
    // Recording only completions makes the rate finished/finished, which is
    // always 100% and measures nothing.
    expect(mobileTier0CompletionOutcome("completed")).toBe("ok");
    expect(mobileTier0CompletionOutcome("abandoned")).toBe("withheld");
  });

  it("starts once per task, not once per re-render", () => {
    expect(source).toContain("started.current");
    expect(source).toContain("if (!isPhone || started.current || !decisionKey) return");
  });

  it("completes at most once", () => {
    expect(source).toContain("if (completed.current) return;");
  });

  it("emits both section-9 mobile events", () => {
    expect(source).toContain('eventName: "mobile_tier0_started"');
    expect(source).toContain('eventName: "mobile_tier0_completed"');
    expect(source).toContain('surface: "mobile"');
    expect(source).toContain('scope: "business"');
  });

  it("does not fire a start before the task can begin", () => {
    // A start with no decision would count opening the page as opening a task.
    expect(source).toContain("!decisionKey");
  });
});

describe("it is actually mounted", () => {
  it("wraps the ownership controls on the Decisions surface", () => {
    // An emitter that is never rendered is dead vocabulary.
    const view = readFileSync("components/meta/os/DecisionsOsView.tsx", "utf8");
    expect(view).toContain("MobileTier0Triage");
    expect(view).toContain("DecisionWorkflowControls");
  });
});

describe("no provider mutation reaches this surface", () => {
  it("writes nothing beyond its own telemetry", () => {
    expect(source).not.toContain("fetch(");
    expect(source).not.toMatch(/method:\s*"(POST|PATCH|DELETE)"/);
    // The one call out is the bounded instrumentation endpoint.
    expect(source).toContain("emitProductInstrumentation");
  });
});

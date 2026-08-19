import { describe, expect, it } from "vitest";
import {
  LAUNCHPAD_VIEWER_NOT_ESTABLISHED,
  buildLaunchpadViewerEnvelope,
} from "./viewer-envelope";

describe("the refusal code is the server's, not a client re-derivation", () => {
  // The surface used to build its own code from reviewerReadOnly/demo with a
  // final `else "insufficient_role"`. That last branch swallowed the
  // unverified case: a workspace whose is_demo_business flag could not be read
  // was told it lacked permission, while the route was going to answer 503
  // demo_status_unverified. The envelope now carries the route's own spelling
  // so the two can never drift.
  it("names the unverified case instead of blaming the operator's role", () => {
    const viewer = buildLaunchpadViewerEnvelope({
      role: "admin",
      reviewerReadOnly: false,
      writeAuthority: "unverified",
    });
    expect(viewer.canMutate).toBe(false);
    expect(viewer.refusalCode).toBe("demo_status_unverified");
  });

  it("keeps the route's precedence: reviewer outranks demo outranks role", () => {
    expect(
      buildLaunchpadViewerEnvelope({
        role: "guest",
        reviewerReadOnly: true,
        writeAuthority: "demo",
      }).refusalCode,
    ).toBe("reviewer_read_only");
    expect(
      buildLaunchpadViewerEnvelope({
        role: "guest",
        reviewerReadOnly: false,
        writeAuthority: "demo",
      }).refusalCode,
    ).toBe("demo_business_read_only");
    expect(
      buildLaunchpadViewerEnvelope({
        role: "guest",
        reviewerReadOnly: false,
        writeAuthority: "live",
      }).refusalCode,
    ).toBe("insufficient_role");
  });

  it("carries a code exactly when it refuses", () => {
    const allowed = buildLaunchpadViewerEnvelope({
      role: "admin",
      reviewerReadOnly: false,
      writeAuthority: "live",
    });
    expect(allowed.canMutate).toBe(true);
    expect(allowed.refusalCode).toBeNull();
    expect(allowed.reason).toBeNull();
  });
});

describe("an unestablished viewer is held, not admitted", () => {
  // LAW: missing or unreadable data must never become success. The preserved
  // legacy mount at /platforms/meta/launchpad renders the body through
  // `lib/zero-base/compatibility-page.tsx`, which passes the shim's own props
  // and no viewer — so `role` is null, the reviewer posture is unknown, and
  // `businesses.is_demo_business` was never read. `canMutate: true` there meant
  // a reviewer, a guest and a demo admin all got ACTIVE Save template / Save
  // draft / Launch controls whose only refusal was the 403 that arrives after
  // the click.
  //
  // That mount is reachable in three of the four rollout modes
  // (`decideCompatibility` renders the legacy body for uiMode "off", for every
  // business-scoped path under "internal", and for a non-allowlisted business
  // under "allowlist") and, under "on", whenever `authorizeBusiness` answers
  // `schema_unavailable` — the one state where the canonical route would have
  // answered `unverified` and held the write.
  it("refuses when no server established the viewer", () => {
    expect(LAUNCHPAD_VIEWER_NOT_ESTABLISHED.canMutate).toBe(false);
    expect(LAUNCHPAD_VIEWER_NOT_ESTABLISHED.reason).toContain(
      "did not establish who is looking",
    );
  });

  // The code is deliberately NOT one of the four route codes. Those name what
  // an endpoint would answer; this one names what this page failed to resolve.
  // Spelling it `insufficient_role` would blame the operator's role for a fact
  // nobody read — the exact re-derivation this envelope exists to prevent.
  it("names the unresolved viewer instead of borrowing a route's code", () => {
    expect(LAUNCHPAD_VIEWER_NOT_ESTABLISHED.refusalCode).toBe(
      "viewer_not_established",
    );
  });

  it("carries no role and claims no demo verdict it did not read", () => {
    expect(LAUNCHPAD_VIEWER_NOT_ESTABLISHED.role).toBeNull();
    expect(LAUNCHPAD_VIEWER_NOT_ESTABLISHED.demo).toBe(false);
    expect(LAUNCHPAD_VIEWER_NOT_ESTABLISHED.reviewerReadOnly).toBe(false);
  });

  // A resolved server viewer still outranks it: the four route codes keep their
  // precedence, and `not_established` only applies when nothing was resolved.
  it("does not shadow a refusal a server actually resolved", () => {
    expect(
      buildLaunchpadViewerEnvelope({
        role: "admin",
        reviewerReadOnly: true,
        writeAuthority: "not_established",
      }).refusalCode,
    ).toBe("reviewer_read_only");
  });
});

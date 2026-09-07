import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Inbox may not name a workflow it cannot serve.
 *
 * Proven by named grep and re-provable: `/api/creatives/inbox` serves only
 * cards, `businessId` and cache/status/error plumbing. There are zero repo hits
 * for workflowStatus/workflow_status/columnId/stage, owner/assignee/
 * assigned_to, dueAt/due_at/dueDate, or versionNumber/approvalState/approvedBy,
 * and `lib/migrations.ts` declares no workflow table.
 *
 * The previous fix kept four columns named Requested / In production /
 * Delivered / Live and put a caption under them saying they were unavailable.
 * That was not enough: a column HEADING is itself the claim, and four of them
 * standing over an explanation still tell a reader the pipeline exists. The
 * columns are therefore gone, replaced by the creative-briefing authority's own
 * served sections — which the surface really does read.
 *
 * This file pins the SOURCE TEXT, because these are claims a future edit could
 * reintroduce one word at a time. The rendered behaviour is pinned separately
 * in page.test.tsx.
 */
const PAGE = readFileSync(
  "app/(dashboard)/platforms/meta/creative-inbox/legacy-page.tsx",
  "utf8",
);
const STUDIO = readFileSync(
  "components/creatives/CreativeStudioExact.tsx",
  "utf8",
);
const TYPES = readFileSync(
  "components/creatives/creative-studio-exact-types.ts",
  "utf8",
);

describe("the Inbox never implies a workflow backend", () => {
  it("does not promise that a workflow will load or is loading", () => {
    expect(PAGE).not.toContain("to load the creative workflow");
    expect(PAGE).not.toContain("Loading creative workflow");
  });

  it("does not describe absent items as withheld workflow items", () => {
    // "withheld" says the items exist and we are holding them.
    expect(PAGE).not.toContain("workflow items remain withheld");
    expect(PAGE).not.toContain("No workflow items are available");
  });

  /**
   * The four pipeline lanes are removed at the TYPE level, so a page cannot
   * reintroduce one without changing the union and being seen doing it.
   */
  it("no longer models a Requested/In production/Delivered/Live pipeline", () => {
    const union = TYPES.slice(
      TYPES.indexOf("export type CreativeInboxColumnId"),
      TYPES.indexOf("export type CreativeInboxColumnId") + 200,
    );
    expect(union).toContain('"action-now"');
    expect(union).toContain('"watching"');
    expect(union).toContain('"healthy"');
    expect(union).not.toContain('"requested"');
    expect(union).not.toContain('"in-production"');
    expect(union).not.toContain('"delivered"');
    expect(union).not.toContain('"live"');
  });

  /**
   * The card model carries no owner, no due date and no action, because the
   * product records none of them. An em dash in an owner slot would still be
   * telling the reader that owners are a thing here.
   */
  it("models no owner, due date, version or approval on a card", () => {
    const card = TYPES.slice(
      TYPES.indexOf("export interface CreativeStudioInboxCard"),
      TYPES.indexOf("export interface CreativeStudioInboxColumn"),
    );
    expect(card).not.toContain("ownerInitials");
    expect(card).not.toContain("due");
    expect(card).not.toContain("actionLabel");
    expect(card).not.toContain("approval");
    expect(card).not.toContain("version");
  });

  /** No upload affordance: there is no multipart handler and no storage. */
  it("draws no upload drop zone", () => {
    expect(STUDIO).not.toContain("Drop new exports here");
    expect(STUDIO).not.toContain(">Browse files<");
    expect(TYPES).not.toContain("onBrowseFiles");
  });

  it("does not expose the absent request/version/approval workflow as UI copy", () => {
    expect(PAGE).not.toContain("const WORKFLOW_UNBUILT");
    expect(PAGE).not.toContain("are not built");
    expect(PAGE).not.toContain(
      "no request, owner, due date, version or approval is recorded anywhere",
    );
    expect(STUDIO).not.toContain("are not built");
    expect(STUDIO).not.toContain("Requests are intended to route here from");
  });

  it("keeps a failed read distinct from a genuine zero", () => {
    // Both sentences must exist, and they must not be the same sentence.
    expect(PAGE).toContain("Creative decisions are temporarily unavailable.");
    expect(PAGE).toContain("No creative decisions need attention.");
  });

  it("keeps the served decision items without exposing backend authority wording", () => {
    expect(PAGE).not.toMatch(/creative briefing authority/i);
    expect(PAGE).toContain("Creative decisions");
  });
});

describe("an unreadable inventory is not a measured zero", () => {
  /**
   * `/api/creatives/briefing` answers HTTP 200 with empty lanes AND
   * `canonicalDecisionInventory: { status: "unavailable", unavailableReason }`
   * when it could not read the account's decision inventory. The Inbox read
   * only `inbox ?? []`, so that success-shaped failure drew as an empty board:
   * "this account has nothing to act on" when the truth was "we could not read
   * what it has". It is the live state of act_822913786458311, not a
   * hypothetical.
   *
   * Pinned on the source because the defect is a branch that did not exist.
   */
  const PAGE = readFileSync(
    "app/(dashboard)/platforms/meta/creative-inbox/legacy-page.tsx",
    "utf8",
  );

  it("reads the authority's own inventory status", () => {
    expect(PAGE).toContain("canonicalDecisionInventory");
    expect(PAGE).toContain("inventoryUnavailable");
  });

  it("treats an unavailable inventory as a failed read, not an empty one", () => {
    expect(PAGE).toMatch(
      /readFailed\s*=\s*scopeError \|\| inboxQuery\.isError \|\| inventoryUnavailable/,
    );
  });

  it("shows a concise unavailable state without exposing inventory internals", () => {
    expect(PAGE).toContain("Creative decisions are temporarily unavailable.");
    expect(PAGE).not.toContain(
      "could not read this account's decision inventory",
    );
    expect(PAGE).not.toContain("inventoryUnavailableReason");
  });

  it("still reports a genuine zero as a zero", () => {
    // The opposite error is equally wrong: an authority that really served
    // nothing must not be reported as unreadable.
    expect(PAGE).toContain("No creative decisions need attention.");
  });
});

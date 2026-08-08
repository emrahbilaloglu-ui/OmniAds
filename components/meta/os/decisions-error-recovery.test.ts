import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("components/meta/os/DecisionsOsView.tsx", "utf8");
const css = readFileSync("components/meta/os/DecisionsOsView.module.css", "utf8");

/**
 * A failed workspace read used to leave a full browser reload as the only way
 * forward, on the surface a buyer is triaging from.
 */
describe("Decisions recovers from a failed read", () => {
  it("offers a retry on the error state", () => {
    expect(source).toContain("onRetry");
    expect(source).toContain("Try again");
  });

  it("re-runs the queries that actually failed", () => {
    expect(source).toContain("providerAccountsQuery.refetch()");
    expect(source).toContain("workspaceQuery.refetch()");
  });

  it("only refetches a query that is in error, not every query", () => {
    expect(source).toContain("if (providerAccountsQuery.isError) void providerAccountsQuery.refetch();");
    expect(source).toContain("if (workspaceQuery.isError) void workspaceQuery.refetch();");
  });

  it("disables the control while a retry is in flight rather than queuing repeats", () => {
    expect(source).toContain("retrying={");
    expect(source).toContain("disabled={retrying}");
  });

  it("keeps the retry out of states that are not failures", () => {
    // onRetry is optional; the loading and empty states must not pass one.
    const loadingState = source.slice(
      source.indexOf('title="Loading decision workspace"'),
      source.indexOf('title="Decision workspace unavailable"'),
    );
    expect(loadingState).not.toContain("onRetry");
  });

  it("gives the control a visible affordance", () => {
    expect(css).toContain(".emptyState button");
  });
});

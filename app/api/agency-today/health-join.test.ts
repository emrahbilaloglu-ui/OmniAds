import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What Agency Today means by a client's health.
 *
 * The row used to derive health from connection status alone, and before that
 * from whether totals happened to exist. Both let the same client read
 * differently here than on Integrations at the same moment, which is the worst
 * place for that: Agency Today exists to decide who to look at, so a client
 * that reads healthy here does not get looked at.
 *
 * The case that mattered most was a client connected with no account selected.
 * Nothing can produce data for it, a person has to fix it, and this surface
 * called it healthy — finding G0-F5 reappearing on the triage surface.
 */
const route = readFileSync("app/api/agency-today/route.ts", "utf8");

describe("health comes from the connection, not from whether numbers exist", () => {
  it("reads the canonical connection status", () => {
    expect(route).toContain("FROM provider_connections pc");
    expect(route).toContain("pc.provider = 'meta'");
  });

  it("also reads whether an account is actually selected", () => {
    // Status alone cannot distinguish "connected and working" from "connected
    // and pointed at nothing".
    expect(route).toContain("business_provider_accounts binding");
    expect(route).toContain("binding.is_selected");
    expect(route).toContain("selected_count");
  });

  it("treats connected-but-unselected as needing a person", () => {
    expect(route).toContain("Number(connection.selected_count ?? 0) === 0");
    expect(route).toContain('? "action_required"');
  });

  it("treats revoked, expired and error alike, as Integrations does", () => {
    // Integrations maps expired and error to action_required together
    // (store/integrations-support.ts). Diverging here is how the two surfaces
    // disagreed in the first place.
    expect(route).toContain('connection.status === "revoked"');
    expect(route).toContain('connection.status === "expired"');
    expect(route).toContain('connection.status === "error"');
  });

  it("keeps an absent connection distinct from an unhealthy one", () => {
    // Never connected is a different thing from connected and broken, and the
    // operator does something different about each.
    expect(route).toContain('!connection\n      ? "disconnected"');
  });

  it("still degrades rather than lies when a healthy client has no totals", () => {
    expect(route).toContain('? "healthy"');
    expect(route).toContain(': "degraded"');
  });

  it("reports a failed read as a failure instead of an empty board", () => {
    // An empty Agency Today renders as "every client is quiet", which is the
    // most dangerous possible lie on a triage surface.
    expect(route).toContain("agency_today_unavailable");
    expect(route).toContain("{ status: 503 }");
  });
});

describe("the precedence it does not share is stated, not implied", () => {
  it("the ledger names what Integrations knows that this join does not", () => {
    const ledger = readFileSync(
      "docs/full-ui-redesign/UX_REMEDIATION_LEDGER.md",
      "utf8",
    );
    // Integrations additionally classifies discovery failures, quota-class
    // errors and stale-cached reads client-side. Claiming full parity would be
    // the overstatement this row was corrected for.
    expect(ledger).toContain("discovery-failure classification");
  });
});

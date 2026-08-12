import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BULK_WITHHELD_REASON,
  FORBIDDEN_LAUNCH_ENDPOINTS,
  MAX_BULK_ADS,
  TEMPLATE_ACTIONS,
  WHAT_DOES_NOT_EXIST,
  WHAT_WORKS_TODAY,
  disabledLaunchActions,
  firstBlockingField,
  gateBulkRequest,
  hasBlockingError,
  launchPrerequisites,
  reconcileBulkOutcomes,
} from "@/lib/zero-base/launchpad/launchpad-contract";

const ROOT = process.cwd();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The load-bearing test: the canonical bundle cannot reach launch execution.
 *
 * Not "the button is disabled" — the endpoint strings appear nowhere in the
 * shipped client or route code, so no flag flip and no refactor can reach them.
 */
describe("zero call sites to launch execution", () => {
  const files = [
    ...walk(path.join(ROOT, "components", "zero-base", "launchpad")),
    ...walk(path.join(ROOT, "lib", "zero-base", "launchpad")),
    path.join(ROOT, "app", "c", "[businessId]", "meta", "launchpad", "page.tsx"),
  ];

  it("scans a non-empty set of shipped files", () => {
    // A test that scanned nothing would pass forever.
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.some((f) => f.endsWith("launchpad-client.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("page.tsx"))).toBe(true);
  });

  it("would catch a call site if one were added", () => {
    // Guards the guard: the matcher really does fire on the forbidden shape.
    const sample = 'await fetch("/api/launchpad/meta/launch", { method: "POST" });';
    expect(sample.includes(FORBIDDEN_LAUNCH_ENDPOINTS[0])).toBe(true);
    expect(/\/meta\/launch(?![a-z-])/i.test(sample)).toBe(true);
    expect(/\/meta\/launch(?![a-z-])/i.test('fetch("/api/launchpad/meta/templates")')).toBe(false);
  });

  /**
   * Comments are stripped first.
   *
   * The point is call sites, not vocabulary: a doc comment explaining why the
   * launch endpoints are absent is evidence FOR the rule, and a test that
   * failed on it would push authors to delete the explanation.
   */
  function code(file: string): string {
    return readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  }

  it("strips comments without stripping the code", () => {
    const source = code(path.join(ROOT, "components", "zero-base", "launchpad", "launchpad-client.tsx"));
    expect(source).toContain("/api/launchpad/meta/templates");
    expect(source).not.toContain("not a guarded one");
  });

  it("references neither launch endpoint anywhere in the canonical bundle", () => {
    for (const file of files) {
      // The contract module declares the forbidden paths as a constant so this
      // test can check for them; that declaration is the only occurrence
      // anywhere, and it is not a call site.
      if (file.endsWith("launchpad-contract.ts")) continue;
      const source = code(file);
      for (const endpoint of FORBIDDEN_LAUNCH_ENDPOINTS) {
        expect(source.includes(endpoint), `${path.basename(file)} → ${endpoint}`).toBe(false);
      }
      // Bounded so "launchpad" does not count as "launch": the endpoint is
      // `/meta/launch` with nothing word-like after it.
      expect(/\/meta\/launch(?![a-z-])/i.test(source), path.basename(file)).toBe(false);
      expect(source.includes("add-to-existing"), path.basename(file)).toBe(false);
    }
  });
});

describe("launch is disabled with its exact prerequisites", () => {
  it("names rollback, origin and confirmation, all unmet", () => {
    const items = launchPrerequisites();
    expect(items.map((item) => item.id)).toEqual(["rollback", "origin", "confirmation"]);
    for (const item of items) {
      expect(item.met).toBe(false);
      expect(item.detail.length).toBeGreaterThan(40);
    }
  });

  it("disables both execution actions and counts the unmet prerequisites", () => {
    const actions = disabledLaunchActions();
    expect(actions.map((a) => a.id)).toEqual(["launch", "add_to_existing"]);
    for (const action of actions) {
      expect(action.disabled).toBe(true);
      expect(action.summary).toMatch(/3 prerequisites are not met/);
    }
  });

  it("claims nothing in What works today that is not mounted", () => {
    const claims = WHAT_WORKS_TODAY.join(" ");
    // Every line must correspond to a wired call; the first version claimed
    // drafts, templates and validation that were never mounted.
    expect(claims).toMatch(/Drafts are listed/);
    expect(claims).toMatch(/Templates are listed, created, and deleted/);
    expect(claims).toMatch(/Validation runs your draft payload/);
    expect(claims).not.toMatch(/can be created and edited here, and they are saved/);
  });

  it("does not claim a rollback that does not exist", () => {
    const rollback = launchPrerequisites().find((item) => item.id === "rollback")!;
    expect(rollback.detail).toMatch(/no rollback for that today/);
    expect(WHAT_DOES_NOT_EXIST.join(" ")).toMatch(/no rollback for a launch/);
  });

  it("does not imply Google Launchpad parity", () => {
    const all = [...WHAT_WORKS_TODAY, ...WHAT_DOES_NOT_EXIST].join(" ");
    expect(all).toMatch(/no Google Launchpad/);
    expect(all).toMatch(/Meta only/);
  });

  it("states plainly that nothing here changes Meta", () => {
    expect(WHAT_WORKS_TODAY.join(" ")).toMatch(/Nothing on this page creates, changes or launches/);
  });
});

describe("templates are immutable", () => {
  it("offers read, duplicate and delete — and no update", () => {
    expect([...TEMPLATE_ACTIONS]).toEqual(["read", "duplicate", "delete"]);
    expect(TEMPLATE_ACTIONS).not.toContain("update");
    expect(TEMPLATE_ACTIONS).not.toContain("edit");
  });
});

describe("validation focus", () => {
  const findings = [
    { id: "1", field: null, severity: "warning" as const, message: "Consider a shorter headline." },
    { id: "2", field: "name", severity: "error" as const, message: "Ad name is required." },
    { id: "3", field: "budget", severity: "error" as const, message: "Budget is required." },
  ];

  it("points at the first field that actually blocks progress", () => {
    expect(firstBlockingField(findings)).toBe("name");
  });

  it("ignores warnings when choosing where to send focus", () => {
    expect(firstBlockingField([findings[0]])).toBeNull();
  });

  it("reports whether anything blocks at all", () => {
    expect(hasBlockingError(findings)).toBe(true);
    expect(hasBlockingError([findings[0]])).toBe(false);
  });
});

describe("bulk ad status", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `ad-${i}`);

  it("is unavailable when the mutation UI flag is off", () => {
    const gate = gateBulkRequest({ mutationUiEnabled: false, adIds: ids(3) });
    expect(gate.ok).toBe(false);
    expect(!gate.ok && gate.reason).toMatch(/not enabled/);
  });

  it("is withheld even with the flag on, because the exact contract cannot be built here", () => {
    // The real handler needs per-item ad and creative identity plus a
    // canonical action origin. This page holds none of it, so the flag alone
    // is not sufficient and the request is refused before it is assembled.
    const gate = gateBulkRequest({ mutationUiEnabled: true, adIds: ids(3) });
    expect(gate.ok).toBe(false);
    expect(!gate.ok && gate.reason).toBe(BULK_WITHHELD_REASON);
  });

  it("still enforces the cap for a caller that CAN build the exact contract", () => {
    const ok = gateBulkRequest({ mutationUiEnabled: true, adIds: ids(MAX_BULK_ADS), canBuildExactContract: true });
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.adIds).toHaveLength(20);

    const over = gateBulkRequest({ mutationUiEnabled: true, adIds: ids(21), canBuildExactContract: true });
    expect(over.ok).toBe(false);
    expect(!over.ok && over.reason).toMatch(/at most 20 ads\. 21 were selected/);
  });

  it("de-duplicates before counting, so a repeat is not a rejection", () => {
    const gate = gateBulkRequest({ mutationUiEnabled: true, adIds: ["a", "a", "b"], canBuildExactContract: true });
    expect(gate.ok && gate.adIds).toEqual(["a", "b"]);
  });

  it("refuses an empty selection", () => {
    expect(gateBulkRequest({ mutationUiEnabled: true, adIds: [], canBuildExactContract: true }).ok).toBe(false);
  });
});

describe("per-item bulk outcomes", () => {
  it("reports each item separately rather than one verdict", () => {
    const outcomes = reconcileBulkOutcomes({
      requested: ["a", "b", "c"],
      served: [
        { adId: "a", status: "applied", detail: "Paused." },
        { adId: "b", status: "refused", detail: "Already paused." },
      ],
    });
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "refused", "unknown"]);
  });

  it("treats an unmentioned item as unknown, never as applied", () => {
    const outcomes = reconcileBulkOutcomes({ requested: ["a"], served: [] });
    expect(outcomes[0].status).toBe("unknown");
    expect(outcomes[0].detail).toMatch(/did not report an outcome/);
  });

  it("treats an unclassified status as unknown", () => {
    const outcomes = reconcileBulkOutcomes({
      requested: ["a"],
      served: [{ adId: "a", status: "weird" }],
    });
    expect(outcomes[0].status).toBe("unknown");
  });

  it("maps the server's success and failure words onto its two settled states", () => {
    const outcomes = reconcileBulkOutcomes({
      requested: ["a", "b"],
      served: [
        { adId: "a", status: "success" },
        { adId: "b", status: "error" },
      ],
    });
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "refused"]);
  });
});

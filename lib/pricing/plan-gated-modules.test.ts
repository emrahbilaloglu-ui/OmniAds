/**
 * The list is held against the tree, not trusted.
 *
 * `PLAN_GATED_MODULES` exists so Plan & Billing can state what the plan gates.
 * A hand-maintained list that drifts is exactly how the previous sentence came
 * to be false, so this reads the real gates back out of the source and fails
 * when the two disagree in either direction.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { PLAN_GATED_MODULES, planGatingDisclosure } from "@/lib/pricing/plan-gated-modules";

/** Every `<PlanGate requiredPlan="…">` in the tree, as file → plan. */
function planGatesInSource(): { file: string; plan: string }[] {
  // `git grep -E` is POSIX ERE and has no `\s`; the shape is matched in JS
  // instead, which also lets a mention inside a comment be excluded.
  const output = execFileSync(
    "git",
    ["grep", "-n", "PlanGate requiredPlan=", "--", "app", "components"],
    { encoding: "utf8" },
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [file, , ...rest] = line.split(":");
      return { file: file!, code: rest.join(":") };
    })
    .filter((row) => !row.file.includes(".test."))
    // The element, not a sentence about it: `settings-exact-adapter.ts`
    // documents the gate in a comment and does not impose one.
    .filter((row) => /^\s*<PlanGate\s+requiredPlan="[a-z]+"/.test(row.code))
    .map((row) => ({
      file: row.file,
      plan: /requiredPlan="([a-z]+)"/.exec(row.code)?.[1] ?? "",
    }));
}

/** Every `requiredPlan` in the rail registry, as label → plan. */
function railPlanRequirements(): string[] {
  const output = execFileSync("git", ["grep", "-n", "requiredPlan: \"", "--", "components/layout"], {
    encoding: "utf8",
  });

  return output
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.includes(".test."))
    .map((line) => /requiredPlan: "([a-z]+)"/.exec(line)?.[1] ?? "")
    .filter(Boolean);
}

describe("what the plan gates is stated from what the plan gates", () => {
  it("covers every PlanGate in the tree", () => {
    const gates = planGatesInSource();
    expect(gates.length, "no PlanGate found — the detector is broken, not the tree").toBeGreaterThan(
      0,
    );

    const declaredFiles = new Set(PLAN_GATED_MODULES.map((module) => module.enforcedIn));
    const missing = gates
      .filter((gate) => !declaredFiles.has(gate.file))
      .map((gate) => `${gate.file} (${gate.plan})`);
    expect(missing, "PlanGate present in the tree but not declared on Plan & Billing").toEqual([]);
  });

  it("declares the same plan the gate enforces", () => {
    const byFile = new Map(planGatesInSource().map((gate) => [gate.file, gate.plan]));
    const wrong = PLAN_GATED_MODULES.filter((module) => byFile.has(module.enforcedIn))
      .filter((module) => byFile.get(module.enforcedIn) !== module.requiredPlan)
      .map((module) => `${module.label}: says ${module.requiredPlan}, gate says ${byFile.get(module.enforcedIn)}`);
    expect(wrong).toEqual([]);
  });

  it("covers every plan requirement the rail declares", () => {
    const railPlans = new Set(railPlanRequirements());
    const declaredPlans = new Set(PLAN_GATED_MODULES.map((module) => module.requiredPlan));
    const uncovered = [...railPlans].filter((plan) => !declaredPlans.has(plan as never));
    expect(uncovered, "the rail hides rows behind a plan Plan & Billing never mentions").toEqual([]);
  });

  it("names the modules rather than gesturing at them", () => {
    const disclosure = planGatingDisclosure();
    expect(disclosure).toContain("Creative Studio — Copies");
    expect(disclosure).toContain("Reports");
    expect(disclosure).toContain("Growth");
    // And it must not be the old claim in new words.
    expect(disclosure).not.toMatch(/No route or control/);
  });
});

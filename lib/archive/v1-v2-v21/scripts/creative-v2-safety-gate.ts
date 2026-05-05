// Creative v2 hardening file: read-only safety gate; behavior unchanged.
// Public Raw verification marker: multiline LF formatting required.
import { spawnSync } from "node:child_process";
import {
  evaluateCreativeDecisionOsV2Gold,
  readGoldLabelsV0,
} from "@/lib/creative-decision-os-v2-evaluation";

const focusedTestFiles = [
  "lib/creative-decision-os-v2.test.ts",
  "lib/creative-decision-os-v2-preview.test.tsx",
  "lib/creative-v2-no-write-enforcement.test.ts",
  "lib/get-route-side-effect-guard.test.ts",
  "src/services/data-service-ai.test.ts",
  "components/creatives/CreativeDecisionSupportSurface.test.tsx",
  "components/creatives/CreativesTableSection.test.tsx",
  "app/(dashboard)/creatives/page.test.tsx",
  "app/api/creatives/decision-os-v2/preview/route.test.ts",
];

const focusedVitestArgs = ["vitest", "run", ...focusedTestFiles];
const safetyThresholds = {
  minimumMacroF1: 90,
} as const;

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}`,
    );
  }
}

run("npx", focusedVitestArgs);

const evaluation = evaluateCreativeDecisionOsV2Gold(readGoldLabelsV0());
const failures: string[] = [];

function requireAtLeast(label: string, actual: number, minimum: number) {
  if (actual < minimum) failures.push(`${label} below ${minimum}: ${actual}`);
}

function requireZero(label: string, actual: number) {
  if (actual !== 0) failures.push(`${label}: ${actual}`);
}

requireAtLeast("macroF1", evaluation.macroF1, safetyThresholds.minimumMacroF1);
requireZero("severe mismatches", evaluation.mismatchCounts.severe);
requireZero("high mismatches", evaluation.mismatchCounts.high);

const safetyCounters = evaluation.queueApplySafety;
requireZero("Watch primary outputs", safetyCounters.watchPrimaryCount);
requireZero(
  "Scale Review primary outputs",
  safetyCounters.scaleReviewPrimaryCount,
);
requireZero("queue eligible outputs", safetyCounters.queueEligibleCount);
requireZero("apply eligible outputs", safetyCounters.applyEligibleCount);
requireZero("direct Scale outputs", safetyCounters.directScaleCount);
requireZero(
  "inactive direct Scale outputs",
  safetyCounters.inactiveDirectScaleCount,
);

if (failures.length > 0) {
  throw new Error(`Creative v2 safety gate failed:\n${failures.join("\n")}`);
}

console.log(
  JSON.stringify(
    {
      creativeV2SafetyGate: "passed",
      artifactVersion: evaluation.artifactVersion,
      rowCount: evaluation.rowCount,
      macroF1: evaluation.macroF1,
      mismatchCounts: evaluation.mismatchCounts,
      queueApplySafety: evaluation.queueApplySafety,
    },
    null,
    2,
  ),
);

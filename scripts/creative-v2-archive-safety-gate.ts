import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const archiveRoot = "lib/archive/v1-v2-v21";
const expectedCompatibilityFiles = [
  "lib/creative-decision-os-v2.test.ts",
  "lib/creative-decision-os-v2-preview.test.tsx",
  "lib/creative-v2-no-write-enforcement.test.ts",
  "src/services/data-service-ai.test.ts",
  "components/creatives/CreativeDecisionSupportSurface.test.tsx",
  "components/creatives/CreativesTableSection.test.tsx",
  "app/(dashboard)/platforms/meta/creatives/page.test.tsx",
  "app/api/creatives/decision-os-v2/preview/route.test.ts",
];

const safetyThresholds = {
  minimumMacroF1: 90,
} as const;

type CreativeDecisionOsV2EvaluationModule = {
  evaluateCreativeDecisionOsV2Gold: (
    artifact: unknown,
  ) => {
    artifactVersion: string;
    rowCount: number;
    macroF1: number;
    mismatchCounts: Record<string, number>;
    queueApplySafety: Record<string, number>;
  };
  readGoldLabelsV0: () => unknown;
};

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

function requireAtLeast(label: string, actual: number, minimum: number) {
  if (actual < minimum) {
    throw new Error(`${label} below ${minimum}: ${actual}`);
  }
}

function requireZero(label: string, actual: number) {
  if (actual !== 0) throw new Error(`${label}: ${actual}`);
}

async function main() {
  const missingCompatibilityFiles = expectedCompatibilityFiles.filter(
    (file) =>
      !existsSync(path.join(process.cwd(), archiveRoot, file)) &&
      !existsSync(path.join(process.cwd(), file)),
  );
  if (missingCompatibilityFiles.length > 0) {
    throw new Error(
      `Creative v2 compatibility files missing:\n${missingCompatibilityFiles.join(
        "\n",
      )}`,
    );
  }

  run("npx", ["vitest", "run", "lib/archive/archive-import-guard.test.ts"]);

  const evaluationModuleUrl = pathToFileURL(
    path.join(
      process.cwd(),
      archiveRoot,
      "lib/creative-decision-os-v2-evaluation.ts",
    ),
  ).href;
  const evaluationModule = (await import(
    evaluationModuleUrl
  )) as CreativeDecisionOsV2EvaluationModule;
  const evaluation = evaluationModule.evaluateCreativeDecisionOsV2Gold(
    evaluationModule.readGoldLabelsV0(),
  );

  requireAtLeast(
    "macroF1",
    evaluation.macroF1,
    safetyThresholds.minimumMacroF1,
  );
  requireZero("severe mismatches", evaluation.mismatchCounts.severe ?? 0);
  requireZero("high mismatches", evaluation.mismatchCounts.high ?? 0);
  requireZero(
    "Watch primary outputs",
    evaluation.queueApplySafety.watchPrimaryCount ?? 0,
  );
  requireZero(
    "Scale Review primary outputs",
    evaluation.queueApplySafety.scaleReviewPrimaryCount ?? 0,
  );
  requireZero(
    "queue eligible outputs",
    evaluation.queueApplySafety.queueEligibleCount ?? 0,
  );
  requireZero(
    "apply eligible outputs",
    evaluation.queueApplySafety.applyEligibleCount ?? 0,
  );
  requireZero(
    "direct Scale outputs",
    evaluation.queueApplySafety.directScaleCount ?? 0,
  );
  requireZero(
    "inactive direct Scale outputs",
    evaluation.queueApplySafety.inactiveDirectScaleCount ?? 0,
  );

  console.log(
    JSON.stringify(
      {
        creativeV2ArchiveSafetyGate: "passed",
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

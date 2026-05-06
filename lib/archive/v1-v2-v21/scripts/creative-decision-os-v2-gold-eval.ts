import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  evaluateCreativeDecisionOsV2Gold,
  readGoldLabelsV0,
  GOLD_LABELS_V0_PATH,
} from "@/lib/creative-decision-os-v2-evaluation";

function argValue(name: string) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

const inputPath = argValue("--input") ?? GOLD_LABELS_V0_PATH;
const outputPath = argValue("--output");
const artifact = readGoldLabelsV0(inputPath);
const evaluation = evaluateCreativeDecisionOsV2Gold(artifact);
const serialized = `${JSON.stringify(evaluation, null, 2)}\n`;

if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized);
}

console.log(serialized);

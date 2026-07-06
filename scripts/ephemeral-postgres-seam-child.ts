// Child of ephemeral-postgres-migrations-check: exercises the hysteresis
// DB seam against the freshly-migrated ephemeral database. DATABASE_URL is
// pre-set by the parent to the ephemeral server (never the prod tunnel).
//
// The seam under test is exactly the class the adversarial review caught in
// the campaign-context job: state persisted by the production write query
// must round-trip through the production reader. Here: snapshots written via
// UPSERT_DECISION_SNAPSHOTS_QUERY -> readPreviousPublishedLabels.
import { randomUUID } from "node:crypto";
import { getDb, resetDbClientCache } from "@/lib/db";
import { UPSERT_DECISION_SNAPSHOTS_QUERY } from "@/lib/creative-decision-engine/jobs/decisions-job";
import { readPreviousPublishedLabels } from "@/lib/creative-decision-engine/decision-stability";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

function snapshotRow(input: {
  businessRefId: string;
  creativeId: string;
  asOfDate: string;
  label: string;
  rawLabel: string;
}) {
  return {
    business_ref_id: input.businessRefId,
    business_id: input.businessRefId,
    creative_id: input.creativeId,
    as_of_date: input.asOfDate,
    engine_version: ENGINE_VERSION,
    scope_type: "account",
    scope_id: "*",
    label: input.label,
    raw_label: input.rawLabel,
    confidence: 70,
    truth_source: "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: 0.5,
    badges: [],
    reason: "seam check",
    spend: 100,
    purchases: 1,
    roas: 1,
    recent7d_roas: null,
    label_transform: null,
    job_run_id: null,
    lifecycle_row_id: null,
    calibration_row_id: null,
    computed_at: new Date().toISOString(),
  };
}

async function main() {
  if (process.env.DATABASE_URL?.includes("15432")) {
    throw new Error("seam check refused: DATABASE_URL points at the prod tunnel");
  }
  const db = getDb();
  const businessRefId = randomUUID();

  // Day 1: suppressed transition persisted (published cut, raw keep).
  await db.query(UPSERT_DECISION_SNAPSHOTS_QUERY, [
    JSON.stringify([
      snapshotRow({
        businessRefId,
        creativeId: "seam-creative",
        asOfDate: "2026-07-01",
        label: "cut",
        rawLabel: "keep",
      }),
    ]),
  ]);

  // Day 2 read: production reader must return published cut with raw keep.
  const day2 = await readPreviousPublishedLabels({
    businessId: businessRefId,
    asOf: "2026-07-02",
    creativeIds: ["seam-creative"],
  });
  const memory = day2.get("seam-creative");
  if (!memory || memory.publishedLabel !== "cut" || memory.rawLabel !== "keep") {
    throw new Error(
      `hysteresis seam FAILED: expected published=cut raw=keep, got ${JSON.stringify(memory ?? null)}`,
    );
  }

  // Same-day rerun must NOT see its own output (strictly before asOf).
  const sameDay = await readPreviousPublishedLabels({
    businessId: businessRefId,
    asOf: "2026-07-01",
    creativeIds: ["seam-creative"],
  });
  if (sameDay.has("seam-creative")) {
    throw new Error(
      "hysteresis seam FAILED: same-day rerun read its own snapshot (must be strictly before asOf)",
    );
  }

  // Upsert conflict path: same day rewrite updates label and raw_label.
  await db.query(UPSERT_DECISION_SNAPSHOTS_QUERY, [
    JSON.stringify([
      snapshotRow({
        businessRefId,
        creativeId: "seam-creative",
        asOfDate: "2026-07-01",
        label: "keep",
        rawLabel: "keep",
      }),
    ]),
  ]);
  const afterRerun = await readPreviousPublishedLabels({
    businessId: businessRefId,
    asOf: "2026-07-02",
    creativeIds: ["seam-creative"],
  });
  const rerunMemory = afterRerun.get("seam-creative");
  if (!rerunMemory || rerunMemory.publishedLabel !== "keep" || rerunMemory.rawLabel !== "keep") {
    throw new Error(
      `hysteresis seam FAILED after rerun upsert: got ${JSON.stringify(rerunMemory ?? null)}`,
    );
  }

  console.log(
    "[seam-check] PASS: snapshot write -> readPreviousPublishedLabels round-trips label, raw_label, strict-before-asOf, and rerun upsert.",
  );
  await resetDbClientCache();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

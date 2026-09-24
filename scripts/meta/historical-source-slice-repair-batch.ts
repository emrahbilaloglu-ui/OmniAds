/**
 * Review a bounded set of stale Meta Ad slice bindings, then apply only the
 * individually proven repairs. The underlying repair still locks and rechecks
 * each day before publishing a new pointer at the actual repair time.
 *
 * Dry run:
 *   node --env-file=.env.local --import tsx scripts/meta/historical-source-slice-repair-batch.ts
 *     --from 2026-06-26 --through 2026-09-23 --cutoff 2026-09-24T15:00:00Z
 *     --out-dir /tmp/meta-rebind-review
 * Apply a reviewed directory:
 *   ADSECUTE_META_SLICE_REPAIR_APPLY=1 node --env-file=.env.local --import tsx ...
 *     --apply --out-dir /tmp/meta-rebind-review --expected-batch-hash SHA256
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { configureOperationalScriptRuntime } from "../_operational-runtime";
import { runHistoricalSourceSliceRepair, type Options } from "./historical-source-slice-repair";

const CONTRACT = "meta-historical-source-slice-repair-batch.v1";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/i;
const ACCOUNT = /^act_[a-zA-Z0-9_]+$/;

type Entry = {
  businessId: string; accountId: string; day: string;
  state: string; blockers: string[]; planHash: string;
  manifestId: string | null; rowCount: number | null;
};
type Batch = {
  contract: typeof CONTRACT;
  scope: { from: string; through: string; cutoff: string;
    accountIds: string[] | null };
  entries: Entry[];
  batchHash: string;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parse(argv: string[]) {
  const args = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === "--apply") { apply = true; continue; }
    const value = argv[++index];
    if (!key.startsWith("--") || !value || value.startsWith("--") || args.has(key)) {
      throw new Error(`invalid_argument:${key}`);
    }
    args.set(key, value);
  }
  if ([...args.keys()].some((key) => ![
    "--from", "--through", "--cutoff", "--out-dir", "--accounts",
    "--expected-batch-hash",
  ].includes(key))) throw new Error("unknown_argument");
  const outDir = args.get("--out-dir") ?? "";
  if (!outDir) throw new Error("out_dir_required");
  const accountIds = args.get("--accounts")?.split(",") ?? null;
  if (accountIds?.some((id) => !ACCOUNT.test(id))) throw new Error("invalid_account_id");
  if (apply) {
    const expectedBatchHash = args.get("--expected-batch-hash") ?? "";
    if (!SHA.test(expectedBatchHash) ||
        process.env.ADSECUTE_META_SLICE_REPAIR_APPLY !== "1") {
      throw new Error("apply_requires_opt_in_and_reviewed_batch_hash");
    }
    return { apply, outDir, expectedBatchHash, accountIds };
  }
  const from = args.get("--from") ?? "";
  const through = args.get("--through") ?? "";
  const cutoff = args.get("--cutoff") ?? "";
  if (!DAY.test(from) || !DAY.test(through) || from > through ||
      !Number.isFinite(Date.parse(cutoff)) || !cutoff.endsWith("Z")) {
    throw new Error("real_date_range_and_utc_cutoff_required");
  }
  return { apply, outDir, from, through, cutoff, accountIds };
}

function fileFor(outDir: string, entry: Pick<Entry, "businessId" | "accountId" | "day">) {
  if (!UUID.test(entry.businessId) || !ACCOUNT.test(entry.accountId) ||
      !DAY.test(entry.day)) throw new Error("invalid_scope_in_reviewed_batch");
  return join(outDir, `${entry.businessId}_${entry.accountId}_${entry.day}.plan.json`);
}

function verifyBatch(batch: Batch, expectedHash: string) {
  if (batch.contract !== CONTRACT ||
      batch.batchHash !== expectedHash ||
      digest({ contract: batch.contract, scope: batch.scope,
        entries: batch.entries }) !== expectedHash ||
      !DAY.test(batch.scope.from) || !DAY.test(batch.scope.through) ||
      !Number.isFinite(Date.parse(batch.scope.cutoff))) {
    throw new Error("reviewed_batch_changed_or_invalid");
  }
  const unique = new Set(batch.entries.map((entry) =>
    `${entry.businessId}/${entry.accountId}/${entry.day}`));
  if (unique.size !== batch.entries.length) throw new Error("duplicate_batch_day");
  for (const entry of batch.entries) {
    fileFor(".", entry);
    if (!SHA.test(entry.planHash) || entry.day < batch.scope.from ||
        entry.day > batch.scope.through ||
        !["repairable", "blocked", "already_bound"].includes(entry.state)) {
      throw new Error("invalid_batch_entry");
    }
  }
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.apply) {
    const batch = JSON.parse(readFileSync(join(args.outDir, "batch.json"), "utf8")) as Batch;
    verifyBatch(batch, args.expectedBatchHash!);
    if (args.accountIds &&
        JSON.stringify(args.accountIds) !== JSON.stringify(batch.scope.accountIds)) {
      throw new Error("apply_account_filter_differs_from_reviewed_batch");
    }
    const results: Array<{ entry: Entry; status: string; error?: string }> = [];
    for (const entry of batch.entries.filter((item) => item.state === "repairable")) {
      const options: Options = {
        businessId: entry.businessId, accountId: entry.accountId,
        day: entry.day, cutoff: batch.scope.cutoff,
        out: fileFor(args.outDir, entry), apply: true,
        expectedHash: entry.planHash,
      };
      try {
        await runHistoricalSourceSliceRepair(options);
        results.push({ entry, status: "rebound" });
      } catch (error) {
        // An interrupted prior batch can leave a committed pointer without
        // a completed batch ledger. Re-read at the current time; count it as
        // already done only if the exact reviewed manifest is now bound.
        const current = await runHistoricalSourceSliceRepair({ ...options,
          cutoff: new Date().toISOString(), out: null, apply: false,
          expectedHash: null }).catch(() => null);
        if (current && "state" in current && current.state === "already_bound" &&
            current.next?.manifestId === entry.manifestId &&
            current.old?.publicationReason === "manifest_rebind_repair") {
          results.push({ entry, status: "already_rebound" });
        } else {
          results.push({ entry, status: "failed_closed",
            error: error instanceof Error ? error.message : String(error) });
        }
      }
      writeFileSync(join(args.outDir, "apply-results.json"),
        `${JSON.stringify({ contract: CONTRACT, batchHash: batch.batchHash,
          results }, null, 2)}\n`);
    }
    const failures = results.filter((result) => result.status === "failed_closed");
    process.stdout.write(`${JSON.stringify({ batchHash: batch.batchHash,
      rebound: results.filter((result) => result.status === "rebound").length,
      alreadyRebound: results.filter((result) => result.status === "already_rebound").length,
      failedClosed: failures.length })}\n`);
    if (failures.length > 0) process.exitCode = 1;
    return;
  }

  const outDir = args.outDir;
  const from = args.from!;
  const through = args.through!;
  const cutoff = args.cutoff!;
  if (existsSync(join(outDir, "batch.json"))) {
    throw new Error("review_directory_already_has_batch_use_a_new_directory");
  }
  mkdirSync(outDir, { recursive: true });
  const rows = await getDb().query<{
    business_id: string; provider_account_id: string; day: string;
  }>(`
    SELECT pointer.business_id, pointer.provider_account_id,
      pointer.day::text AS day
    FROM meta_authoritative_publication_pointers pointer
    JOIN meta_authoritative_slice_versions slice
      ON slice.id = pointer.active_slice_version_id
    LEFT JOIN meta_authoritative_source_manifests manifest
      ON manifest.id = slice.manifest_id
    WHERE pointer.surface = 'ad_daily'
      AND pointer.day BETWEEN $1::date AND $2::date
      AND ($3::text[] IS NULL OR pointer.provider_account_id = ANY($3::text[]))
      AND EXISTS (
        SELECT 1 FROM meta_ad_daily ad
        WHERE ad.business_id = pointer.business_id
          AND ad.provider_account_id = pointer.provider_account_id
          AND ad.date = pointer.day
          AND ad.source_snapshot_id::text IS DISTINCT FROM manifest.raw_snapshot_watermark
      )
    ORDER BY pointer.business_id, pointer.provider_account_id, pointer.day
  `, [from, through, args.accountIds]);
  const entries: Entry[] = [];
  // Four read-only plans at a time keep remote DB latency bounded without
  // saturating the web runtime's ten-connection pool.
  for (let offset = 0; offset < rows.length; offset += 4) {
    const group = await Promise.all(rows.slice(offset, offset + 4).map(async (row) => {
      const entryScope = { businessId: row.business_id,
        accountId: row.provider_account_id, day: row.day };
      const plan = await runHistoricalSourceSliceRepair({ ...entryScope,
        cutoff, out: fileFor(outDir, entryScope), apply: false, expectedHash: null });
      if (!("planHash" in plan)) throw new Error("unexpected_apply_receipt_in_dry_run");
      return { ...entryScope, state: plan.state,
        blockers: plan.blockers, planHash: plan.planHash,
        manifestId: plan.next?.manifestId ?? null,
        rowCount: plan.next?.rowCount ?? null };
    }));
    entries.push(...group);
  }
  const batchWithoutHash = { contract: CONTRACT,
    scope: { from, through, cutoff, accountIds: args.accountIds }, entries };
  const batch = { ...batchWithoutHash, batchHash: digest(batchWithoutHash) };
  writeFileSync(join(outDir, "batch.json"), `${JSON.stringify(batch, null, 2)}\n`);
  const blocked = entries.filter((entry) => entry.state === "blocked");
  const reasons = Object.entries(blocked.reduce<Record<string, number>>((counts, entry) => {
    for (const reason of entry.blockers) counts[reason] = (counts[reason] ?? 0) + 1;
    return counts;
  }, {})).sort(([left], [right]) => left.localeCompare(right));
  process.stdout.write(`${JSON.stringify({ batchHash: batch.batchHash,
    candidates: entries.length, repairable: entries.length - blocked.length,
    blocked: blocked.length, reasons })}\n`);
}

if (process.argv[1]?.endsWith("historical-source-slice-repair-batch.ts")) {
  configureOperationalScriptRuntime();
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

import { configureOperationalScriptRuntime } from "./_operational-runtime";

type Mode = "--queue-metric-source" | "--dry-run" | "--apply";

function parseArgs(argv: string[]) {
  const [mode, businessId, startDate, endDate, manifestHash, ...extra] = argv;
  const usage = "usage: node --import tsx scripts/meta-repair-config-history.ts <--queue-metric-source|--dry-run|--apply> <businessId> <startDate> <endDate> [dry-run manifest SHA-256 for --apply]";
  if (
    !["--queue-metric-source", "--dry-run", "--apply"].includes(mode ?? "") ||
    !businessId ||
    !/^\d{4}-\d{2}-\d{2}$/.test(startDate ?? "") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(endDate ?? "") ||
    startDate! > endDate! ||
    extra.length > 0 ||
    (mode === "--apply" ? !/^[a-f0-9]{64}$/.test(manifestHash ?? "") : manifestHash != null)
  ) {
    throw new Error(usage);
  }
  return { mode: mode as Mode, businessId, startDate: startDate!, endDate: endDate!, manifestHash };
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  configureOperationalScriptRuntime();

  // Source collection is queued separately: a queued sync is not a completed
  // observation and must not be followed immediately by historical writes.
  if (input.mode === "--queue-metric-source") {
    const { syncMetaRepairRange } = await import("@/lib/sync/meta-sync");
    const result = await syncMetaRepairRange({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    console.log(JSON.stringify({ ...input, result }, null, 2));
    return;
  }

  const { repairMetaWarehouseTruthRange } = await import("@/lib/meta/repair");
  const result = await repairMetaWarehouseTruthRange({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    dryRun: input.mode === "--dry-run",
    expectedManifestHash: input.mode === "--apply" ? input.manifestHash : undefined,
  });
  console.log(JSON.stringify({ ...input, result }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

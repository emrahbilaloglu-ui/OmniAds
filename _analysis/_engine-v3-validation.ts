import { readFileSync, writeFileSync } from "node:fs";
import {
  decideCreative,
  defaultBusinessConfig,
  WarehouseDataSource,
  type CreativeInput,
} from "@/lib/creative-decision-engine";
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

interface RawRow {
  business_name: string;
  business_id: string;
  snapshot_at: string;
  creative_id: string;
  name: string;
}

interface OutputRow {
  business_name: string;
  business_id: string;
  creative_id: string;
  name: string;
  asOf: string;
  engine_v3_creative_name: string | null;
  engine_v3_label: string;
  engine_v3_confidence: number;
  engine_v3_truth_source: string;
  engine_v3_ratio: number | null;
  engine_v3_target_roas: number;
  engine_v3_badges: string;
  engine_v3_reason: string;
  spend: number;
  purchases: number;
  roas: number | null;
  recent7d_roas: number | null;
  fatigue_status: string | null;
  effective_status: string | null;
  warehouse_missing: boolean;
}

type CsvValue = string | number | boolean | null;

const RAW_PATH = "_analysis/01-raw-with-v1.csv";
const OUT_PATH = "_analysis/08-engine-v3-decisions.csv";

const RESOLVE_WAREHOUSE_CREATIVE_IDS_QUERY = `
SELECT DISTINCT ON (payload_json->>'id')
  payload_json->>'id' AS source_id,
  creative_id
FROM meta_creative_daily
WHERE business_ref_id = $1::uuid
  AND date <= $2::date
  AND payload_json->>'id' = ANY($3::text[])
ORDER BY payload_json->>'id', date DESC, updated_at DESC
`;

const OUTPUT_HEADERS = [
  "business_name",
  "business_id",
  "creative_id",
  "name",
  "asOf",
  "engine_v3_creative_name",
  "engine_v3_label",
  "engine_v3_confidence",
  "engine_v3_truth_source",
  "engine_v3_ratio",
  "engine_v3_target_roas",
  "engine_v3_badges",
  "engine_v3_reason",
  "spend",
  "purchases",
  "roas",
  "recent7d_roas",
  "fatigue_status",
  "effective_status",
  "warehouse_missing",
] as const satisfies readonly (keyof OutputRow)[];

async function main() {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  await withOperationalStartupLogsSilenced(async () => {
    const rows = parseCsv(readFileSync(RAW_PATH, "utf-8"));
    const dataSource = new WarehouseDataSource();
    const output: OutputRow[] = [];

    const groups = groupBy(
      rows,
      (row) => `${row.business_id}::${row.snapshot_at.slice(0, 10)}`,
    );

    for (const [, group] of groups) {
      const first = group[0];
      if (!first) continue;

      const businessId = first.business_id;
      const asOf = first.snapshot_at.slice(0, 10);
      const calibration = await dataSource.getAccountCalibration({
        businessId,
        asOf,
      });
      const config = defaultBusinessConfig(businessId);

      const creativeIds = group.map((row) => row.creative_id);
      const warehouseCreativeIdBySourceId = await resolveWarehouseCreativeIds({
        businessId,
        asOf,
        sourceCreativeIds: creativeIds,
      });
      const warehouseCreativeIds = uniqueStrings(
        creativeIds.map(
          (creativeId) =>
            warehouseCreativeIdBySourceId.get(creativeId) ?? creativeId,
        ),
      );
      const inputs = await dataSource.listCreativeInputs({
        businessId,
        asOf,
        creativeIds: warehouseCreativeIds,
      });
      const inputByWarehouseId = new Map(
        inputs.map((input) => [input.creativeId, input]),
      );
      const inputBySourceId = new Map<string, CreativeInput>();
      for (const row of group) {
        const warehouseCreativeId =
          warehouseCreativeIdBySourceId.get(row.creative_id) ?? row.creative_id;
        const input = inputByWarehouseId.get(warehouseCreativeId);
        if (input) inputBySourceId.set(row.creative_id, input);
      }

      for (const row of group) {
        const input = inputBySourceId.get(row.creative_id);
        if (!input) {
          output.push({
            business_name: row.business_name,
            business_id: row.business_id,
            creative_id: row.creative_id,
            name: row.name,
            asOf,
            engine_v3_creative_name: null,
            engine_v3_label: "missing_in_warehouse",
            engine_v3_confidence: 0,
            engine_v3_truth_source: "n/a",
            engine_v3_ratio: null,
            engine_v3_target_roas: 0,
            engine_v3_badges: "",
            engine_v3_reason:
              "Creative not present in meta_creative_daily for this asOf",
            spend: 0,
            purchases: 0,
            roas: null,
            recent7d_roas: null,
            fatigue_status: null,
            effective_status: null,
            warehouse_missing: true,
          });
          continue;
        }

        const decision = decideCreative(input, config, calibration);
        output.push({
          business_name: row.business_name,
          business_id: row.business_id,
          creative_id: row.creative_id,
          name: row.name,
          asOf,
          engine_v3_creative_name: decision.creativeName,
          engine_v3_label: decision.label,
          engine_v3_confidence: decision.confidence,
          engine_v3_truth_source: decision.truthSource,
          engine_v3_ratio: decision.ratioToTarget,
          engine_v3_target_roas: decision.effectiveTargetRoas,
          engine_v3_badges: decision.badges.map((badge) => badge.type).join(";"),
          engine_v3_reason: decision.reason,
          spend: input.spend,
          purchases: input.purchases,
          roas: input.roas,
          recent7d_roas: input.recent7dRoas,
          fatigue_status: input.fatigueStatus,
          effective_status: input.effectiveStatus,
          warehouse_missing: false,
        });
      }
    }

    writeFileSync(OUT_PATH, toCsv(output));

    const distribution: Record<string, number> = {};
    for (const row of output) {
      distribution[row.engine_v3_label] =
        (distribution[row.engine_v3_label] ?? 0) + 1;
    }

    console.log(`Wrote ${output.length} rows to ${OUT_PATH}`);
    console.log("Distribution:");
    for (const [label, count] of Object.entries(distribution).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`  ${label}: ${count}`);
    }
  });
}

async function resolveWarehouseCreativeIds(input: {
  businessId: string;
  asOf: string;
  sourceCreativeIds: string[];
}): Promise<Map<string, string>> {
  if (input.sourceCreativeIds.length === 0) return new Map();

  const rows = await getDb().query<{
    source_id: unknown;
    creative_id: unknown;
  }>(RESOLVE_WAREHOUSE_CREATIVE_IDS_QUERY, [
    input.businessId,
    input.asOf,
    input.sourceCreativeIds,
  ]);

  const result = new Map<string, string>();
  for (const row of rows) {
    const sourceId = toStringOrNull(row.source_id);
    const warehouseCreativeId = toStringOrNull(row.creative_id);
    if (sourceId && warehouseCreativeId) {
      result.set(sourceId, warehouseCreativeId);
    }
  }
  return result;
}

function parseCsv(content: string): RawRow[] {
  const records = parseCsvRecords(content);
  const header = records[0];
  if (!header) return [];

  const headerIndex = new Map(header.map((name, index) => [name, index]));
  for (const required of [
    "business_name",
    "business_id",
    "snapshot_at",
    "creative_id",
    "name",
  ]) {
    if (!headerIndex.has(required)) {
      throw new Error(`Missing required CSV header: ${required}`);
    }
  }

  return records.slice(1).map((record) => ({
    business_name: getCsvCell(record, headerIndex, "business_name"),
    business_id: getCsvCell(record, headerIndex, "business_id"),
    snapshot_at: getCsvCell(record, headerIndex, "snapshot_at"),
    creative_id: getCsvCell(record, headerIndex, "creative_id"),
    name: getCsvCell(record, headerIndex, "name"),
  }));
}

function parseCsvRecords(content: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (inQuotes) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      record.push(field);
      field = "";
      continue;
    }

    if (char === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      continue;
    }

    if (char === "\r") {
      if (content[index + 1] === "\n") continue;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new Error("Malformed CSV: unterminated quoted field");
  }

  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records.filter((row) => row.some((cell) => cell.length > 0));
}

function getCsvCell(
  record: string[],
  headerIndex: Map<string, number>,
  key: string,
) {
  const index = headerIndex.get(key);
  if (index === undefined) {
    throw new Error(`Missing required CSV header: ${key}`);
  }
  return record[index] ?? "";
}

function toCsv(rows: OutputRow[]): string {
  const lines = [
    OUTPUT_HEADERS.join(","),
    ...rows.map((row) =>
      OUTPUT_HEADERS.map((header) => formatCsvValue(row[header])).join(","),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function formatCsvValue(value: CsvValue): string {
  if (value === null) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function groupBy<T>(
  items: T[],
  keyFn: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    resetDbClientCache();
  });

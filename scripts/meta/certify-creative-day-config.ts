/**
 * Separately certify historical config on source-repaired creative-day rows.
 * Dry-run by default; an apply requires the reviewed manifest hash and an
 * explicit maintenance opt-in. The script never projects current Meta Ad
 * detail back onto a reporting day.
 *
 * node --import tsx scripts/meta/certify-creative-day-config.ts \
 *   --business UUID --account act_ID --day YYYY-MM-DD --knowledge-cutoff ISOZ \
 *   [--apply --expected-manifest-hash SHA256]
 */
import { createHash } from "node:crypto";
import { getDb, runDbTransaction } from "@/lib/db";
import {
  buildCertifiedConfigPayload,
  readCreativeDayConfigProofs,
  type CreativeDayConfigProof,
  type CreativeDayConfigProofVerdict,
} from "@/lib/meta/creative-day-config-proof";
import { configureOperationalScriptRuntime } from "../_operational-runtime";

const CONTRACT = "adsecute.meta-creative-day-config-certification.v1";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[a-f0-9]{64}$/;
type Options = {
  businessId: string; accountId: string; day: string; cutoff: string;
  apply: boolean; expectedManifestHash: string | null;
};

function argsOf(args: string[]): Options {
  const values = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--apply") { apply = true; continue; }
    const key = args[i], value = args[i + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || values.has(key)) {
      throw new Error(`invalid_argument:${key ?? "missing"}`);
    }
    values.set(key, value); i += 1;
  }
  for (const key of values.keys()) {
    if (!["--business", "--account", "--day", "--knowledge-cutoff",
      "--expected-manifest-hash"].includes(key)) throw new Error(`unknown_argument:${key}`);
  }
  const businessId = values.get("--business") ?? "";
  const accountId = values.get("--account") ?? "";
  const day = values.get("--day") ?? "";
  const cutoff = values.get("--knowledge-cutoff") ?? "";
  const expectedManifestHash = values.get("--expected-manifest-hash") ?? null;
  if (!businessId || !accountId || !DAY.test(day) ||
      new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(cutoff) ||
      !Number.isFinite(Date.parse(cutoff))) throw new Error("invalid_scope_or_cutoff");
  if (apply && (!expectedManifestHash || !SHA.test(expectedManifestHash) ||
      process.env.ADSECUTE_CREATIVE_DAY_CONFIG_CERTIFY_APPLY !== "1")) {
    throw new Error("apply_requires_opt_in_and_reviewed_manifest_hash");
  }
  return { businessId, accountId, day, cutoff, apply, expectedManifestHash };
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

type Existing = {
  creative_id: string; objective: string | null; optimization_goal: string | null;
  payload_json: unknown; updated_at: Date | string;
};

async function existingRows(options: Options, lock: boolean): Promise<Existing[]> {
  return getDb().query<Existing>(
    `SELECT creative_id, objective, optimization_goal, payload_json, updated_at
     FROM meta_creative_daily
     WHERE business_id=$1 AND provider_account_id=$2 AND date=$3::date
       AND payload_json->>'source_identity_version'='meta-creative-membership.v2'
       AND payload_json->>'source_parent_grain_complete'='true'
     ORDER BY creative_id ${lock ? "FOR UPDATE" : ""}`,
    [options.businessId, options.accountId, options.day],
  );
}

function stableProof(proof: CreativeDayConfigProof) {
  const { certified_at: _certifiedAt, ...stable } = proof.historical_config_proof;
  return { historical_config_provenance: proof.historical_config_provenance,
    historical_config_proof: stable };
}

async function plan(options: Options) {
  const [oldRows, verdicts] = await Promise.all([
    existingRows(options, false),
    readCreativeDayConfigProofs({ businessId: options.businessId,
      providerAccountId: options.accountId, day: options.day,
      knowledgeCutoffAt: options.cutoff }),
  ]);
  const byId = new Map(oldRows.map((row) => [row.creative_id, row]));
  const seen = new Set(verdicts.map((item) => item.creativeId));
  const excluded = oldRows.filter((row) => !seen.has(row.creative_id));
  const changes: Array<{ creativeId: string; old: unknown; next: unknown;
    proof: CreativeDayConfigProof }> = [];
  for (const verdict of verdicts) {
    if (verdict.status !== "verified") continue;
    const old = byId.get(verdict.creativeId);
    if (!old) throw new Error(`certification_row_missing:${verdict.creativeId}`);
    const payload = record(old.payload_json);
    const previous = {
      historical_config_provenance: payload.historical_config_provenance,
      historical_config_proof: record(payload.historical_config_proof),
    };
    delete previous.historical_config_proof.certified_at;
    const next = stableProof(verdict.proof);
    if (hash(previous) === hash(next) &&
        old.objective === verdict.proof.historical_config_proof.objective &&
        old.optimization_goal === verdict.proof.historical_config_proof.optimization_goal &&
        payload.custom_event_type === verdict.proof.historical_config_proof.custom_event_type &&
        payload.custom_conversion_id === verdict.proof.historical_config_proof.custom_conversion_id) {
      continue;
    }
    changes.push({ creativeId: verdict.creativeId,
      old: { objective: old.objective, optimization_goal: old.optimization_goal,
        custom_event_type: payload.custom_event_type ?? payload.customEventType ?? null,
        custom_conversion_id: payload.custom_conversion_id ?? payload.customConversionId ?? null,
        historical_config_provenance: payload.historical_config_provenance ?? null,
        historical_config_proof: payload.historical_config_proof ?? null,
        payload_hash: hash(payload), updated_at: old.updated_at },
      next,
      proof: verdict.proof });
  }
  const manifest = {
    contract: CONTRACT,
    scope: { businessId: options.businessId, accountId: options.accountId,
      day: options.day, knowledgeCutoffAt: options.cutoff },
    source: "D098_complete_provider_campaign_and_adset_config_receipt_brackets",
    counts: { candidates: oldRows.length,
      verified: verdicts.filter((item) => item.status === "verified").length,
      unverified: verdicts.filter((item) => item.status === "unverified").length +
        excluded.length,
      changes: changes.length },
    blocked: [
      ...verdicts.filter((item): item is Extract<CreativeDayConfigProofVerdict,
        { status: "unverified" }> => item.status === "unverified"),
      ...excluded.map((row) => ({ creativeId: row.creative_id, status: "unverified" as const,
        reason: "source_membership_parent_or_ad_fact_unprovable" })),
    ],
    changes: changes.map(({ creativeId, old, next }) => ({ creativeId, old, next,
      reason: "receipt_bracket_and_value_agreement_verified" })),
  };
  return { manifest, manifestHash: hash(manifest), changes };
}

async function main() {
  configureOperationalScriptRuntime({ lane: "owner_maintenance" });
  const options = argsOf(process.argv.slice(2));
  const dry = await plan(options);
  if (!options.apply) {
    console.log(JSON.stringify({ status: "dry_run", manifestHash: dry.manifestHash,
      manifest: dry.manifest }, null, 2));
    return;
  }
  if (options.expectedManifestHash !== dry.manifestHash) {
    throw new Error("config_certification_manifest_hash_mismatch");
  }
  const readback = await runDbTransaction(async () => {
    const sql = getDb();
    await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `meta_creative_daily:${options.businessId}:${options.accountId}:${options.day}`,
    ]);
    await existingRows(options, true);
    const locked = await plan(options);
    if (locked.manifestHash !== dry.manifestHash) {
      throw new Error("config_certification_source_drift");
    }
    for (const change of locked.changes) {
      const current = await sql.query<Existing>(
        `SELECT creative_id, objective, optimization_goal, payload_json, updated_at
         FROM meta_creative_daily WHERE business_id=$1 AND provider_account_id=$2
         AND date=$3::date AND creative_id=$4`,
        [options.businessId, options.accountId, options.day, change.creativeId],
      );
      if (current.length !== 1) throw new Error(`certification_target_drift:${change.creativeId}`);
      const payload = buildCertifiedConfigPayload(current[0]!.payload_json, change.proof);
      const config = change.proof.historical_config_proof;
      const updated = await sql.query<{ creative_id: string }>(
        `UPDATE meta_creative_daily SET objective=$5, optimization_goal=$6,
           payload_json=$7::jsonb, updated_at=now()
         WHERE business_id=$1 AND provider_account_id=$2 AND date=$3::date
           AND creative_id=$4 RETURNING creative_id`,
        [options.businessId, options.accountId, options.day, change.creativeId,
          config.objective, config.optimization_goal, JSON.stringify(payload)],
      );
      if (updated.length !== 1) throw new Error(`certification_update_failed:${change.creativeId}`);
    }
    const after = await existingRows(options, false);
    for (const change of locked.changes) {
      const row = after.find((item) => item.creative_id === change.creativeId);
      const value = record(row?.payload_json);
      if (!row || row.objective !== change.proof.historical_config_proof.objective ||
          row.optimization_goal !== change.proof.historical_config_proof.optimization_goal ||
          value.historical_config_provenance !== change.proof.historical_config_provenance) {
        throw new Error(`certification_readback_failed:${change.creativeId}`);
      }
    }
    return { changed: locked.changes.length, rows: after.length };
  });
  console.log(JSON.stringify({ status: "applied", manifestHash: dry.manifestHash,
    readback }, null, 2));
}

if (process.argv[1]?.endsWith("certify-creative-day-config.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

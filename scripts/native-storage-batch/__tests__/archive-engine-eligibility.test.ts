import { describe, expect, it } from "vitest";
import { NATIVE_AD_ENGINE_VERSION } from "../../../lib/creative-decision-engine/types";
import { archiveEngineVeto, ARCHIVE_SUPPORTED_ENGINE_VERSIONS } from "../archive-engine-eligibility";
import { collectWholeOriginal } from "../capture";
import { selectClosedDayCandidates } from "../maintenance";
import { vetoPermanence } from "../operator-ownership";

/** D149 archive-engine eligibility: receipt metadata decides BEFORE any source read; headers are never filtered. */
const LEGACY = "v3-ad-2026-07-18-native-shadow";
const id = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const refusal = (p: Promise<unknown>) => p.then(() => "NO_REFUSAL", (e: { code?: string; message?: string }) => e.code ?? e.message);

describe("archive-engine eligibility contract", () => {
  it("supports exactly the authoritative current native engine; everything else is a typed veto", () => {
    expect(ARCHIVE_SUPPORTED_ENGINE_VERSIONS).toEqual([NATIVE_AD_ENGINE_VERSION]);
    expect(archiveEngineVeto(NATIVE_AD_ENGINE_VERSION)).toBeNull();
    expect(archiveEngineVeto(LEGACY)).toBe("ARCHIVE_ENGINE_UNSUPPORTED");                                   // constant code; engine kept on the candidate
    expect(archiveEngineVeto(`${NATIVE_AD_ENGINE_VERSION}x`)).toBe("ARCHIVE_ENGINE_UNSUPPORTED");             // exact match only
    for (const unknown of ["", " ", null, undefined, 7, "engine (unknown)", "x".repeat(121), `legacy-${"x".repeat(300)}`, `${NATIVE_AD_ENGINE_VERSION} `])
      expect(archiveEngineVeto(unknown), String(unknown)).toBe("ARCHIVE_ENGINE_METADATA_UNKNOWN");
  });
  it("classifies an unsupported engine as permanent under the reviewed bounds and unknown metadata as transient", () => {
    expect(vetoPermanence("ARCHIVE_ENGINE_UNSUPPORTED")).toBe("permanent");
    expect(vetoPermanence("ARCHIVE_ENGINE_METADATA_UNKNOWN")).toBe("transient");
  });
});

describe("closed-day selection keeps every header and vetoes by receipt engine", () => {
  it("returns all rows in SQL order with the engine veto first; the SQL never filters by engine", async () => {
    const sql: string[] = [];
    const row = (n: number, engine: string, o: Record<string, unknown> = {}) => ({ job_run_id: id(n), business_id: id(900), as_of_date: "2026-09-01",
      engine_version: engine, row_count: 3, contexts: 1, finished_at: "2026-09-01T02:00:00.000+00:00", later_day: true, ...o });
    const rows = [row(1, LEGACY), row(2, ""), row(3, NATIVE_AD_ENGINE_VERSION), row(4, LEGACY, { row_count: 2000 }), row(5, NATIVE_AD_ENGINE_VERSION, { contexts: 0 }),
      row(6, `legacy-${"x".repeat(300)}`)];
    const db = { query: async (text: string) => {
      sql.push(text);
      if (text.startsWith("SELECT transaction_timestamp()")) return { rows: [{ t: "2026-10-07T00:00:00+00:00", ro: "on" }] };
      if (text.includes("FROM public.engine_v3_job_runs j")) return { rows };
      return { rows: [] };
    } };
    const out = await selectClosedDayCandidates(db, { cursor: null, limit: 32, cutoffObservedAt: "2026-10-06T00:00:00.000Z" });
    expect(out.candidates.map(c => [c.generation.jobRunId, c.metadataVeto])).toEqual([
      [id(1), "ARCHIVE_ENGINE_UNSUPPORTED"], [id(2), "ARCHIVE_ENGINE_METADATA_UNKNOWN"], [id(3), null],
      [id(4), "ARCHIVE_ENGINE_UNSUPPORTED"], [id(5), "CONTEXT_COUNT_OUTSIDE_1_4"], [id(6), "ARCHIVE_ENGINE_METADATA_UNKNOWN"]]);
    expect(out.candidates[0]!.generation.engineVersion).toBe(LEGACY);                                         // the actual engine stays visible
    expect(out.candidates.every(c => c.metadataVeto === null || c.metadataVeto.length <= 200)).toBe(true);
    const select = sql.find(s => s.includes("FROM public.engine_v3_job_runs j"))!;
    expect(select).not.toMatch(/\bj\.engine_version\s*(=|IN\b|<>|!=)/i);                         // no silent engine skip
    expect(sql.at(-1)).toBe("ROLLBACK");
  });
});

describe("direct capture/freeze of unsupported metadata refuses before any source SQL", () => {
  const input = (engineVersion: unknown) => ({ generation: { businessId: id(900), jobRunId: id(1), asOfDate: "2026-09-01", engineVersion } as never,
    expectedEvaluations: 3, expectedContexts: 1, sourceRevision: "a".repeat(40), consumerInventorySha256: "b".repeat(64) });
  it("refuses unsupported and unknown engines with zero statements; a supported engine passes the gate to the existing checks", async () => {
    for (const [engine, code] of [[LEGACY, "ARCHIVE_ENGINE_UNSUPPORTED"], ["", "ARCHIVE_ENGINE_METADATA_UNKNOWN"], [null, "ARCHIVE_ENGINE_METADATA_UNKNOWN"],
      [`legacy-${"x".repeat(300)}`, "ARCHIVE_ENGINE_METADATA_UNKNOWN"]] as const) {
      const sql: string[] = [];
      expect(await refusal(collectWholeOriginal({ query: async (s: string) => { sql.push(s); throw new Error("NO_SQL_EXPECTED"); } }, input(engine))), String(engine)).toBe(code);
      expect(sql, String(engine)).toEqual([]);
    }
    const sql: string[] = [];
    await refusal(collectWholeOriginal({ query: async (s: string) => { sql.push(s); throw new Error("STOP_AFTER_GATE"); } }, input(NATIVE_AD_ENGINE_VERSION)));
    expect(sql[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  });
});

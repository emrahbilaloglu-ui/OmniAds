import { NATIVE_AD_ENGINE_VERSION } from "../../lib/creative-decision-engine/types";

/** D149 archive-engine eligibility. The finite operator archives ONLY originals whose successful job receipt names an
 * explicitly supported native engine. No current code declares any other engine archive-compatible, so this operator
 * contract supports exactly the authoritative current NATIVE_AD_ENGINE_VERSION. A matching engine is a prerequisite,
 * never eligibility proof: the existing whole-original validation still refuses, e.g., absent input evidence.
 * The decision uses receipt metadata BEFORE any evaluation/context read. Every closed-day header stays visible with
 * this typed veto, never a SQL filter or cursor jump. It proves nothing about any future engine. Nothing runs at import. */
export const ARCHIVE_SUPPORTED_ENGINE_VERSIONS: readonly string[] = Object.freeze([NATIVE_AD_ENGINE_VERSION]);
export const ARCHIVE_ENGINE_UNSUPPORTED = "ARCHIVE_ENGINE_UNSUPPORTED" as const;
export const ARCHIVE_ENGINE_METADATA_UNKNOWN = "ARCHIVE_ENGINE_METADATA_UNKNOWN" as const;
const ENGINE_TEXT = /^[a-zA-Z0-9_.-]{1,120}$/;

/** null = supported. Otherwise one of two CONSTANT typed veto codes (the receipt's actual engine stays in the
 * candidate's generation.engineVersion, never in a persisted code): missing, empty, over-long or unsafe engine metadata
 * is unknown; any other exact value is unsupported. */
export function archiveEngineVeto(engineVersion: unknown): typeof ARCHIVE_ENGINE_UNSUPPORTED | typeof ARCHIVE_ENGINE_METADATA_UNKNOWN | null {
  if (typeof engineVersion !== "string" || !ENGINE_TEXT.test(engineVersion)) return ARCHIVE_ENGINE_METADATA_UNKNOWN;
  return ARCHIVE_SUPPORTED_ENGINE_VERSIONS.includes(engineVersion) ? null : ARCHIVE_ENGINE_UNSUPPORTED;
}

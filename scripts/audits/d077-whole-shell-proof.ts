/**
 * D077 correction 3 — whole-shell ordered-header proof builder.
 *
 * Pure, fail-closed: given the RETAINED raw log of one
 * `bash scripts/verify-database-seams.sh` run, the expected log SHA-256 and
 * byte size, and the CURRENT seam script source, it either returns a
 * machine-readable proof of the exact ordered stage-header sequence — or
 * throws a typed error. It never invents totals and never sums nested
 * Vitest summaries: the canonical acceptance unit of the composite shell
 * is the stage sequence plus the final PASS line.
 */
import { createHash } from "node:crypto";

export interface WholeShellHeader {
  number: number;
  title: string;
}

export interface WholeShellProof {
  stageHeaderCount: number;
  headers: WholeShellHeader[];
  sequenceValid: boolean;
  headerDigestFromLog: string;
  headerDigestFromScript: string;
  sourceEquality: boolean;
  releaseOwnerLast: WholeShellHeader;
  finalPassLine: string;
  logSha256: string;
  logBytes: number;
  releaseBoundary: {
    stageNumber: number;
    stageTitle: string;
    markerManifestAgreementLine: string;
    deployGateOrderingPassPresent: boolean;
    excerpt: string;
  };
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function digestHeaders(headers: WholeShellHeader[]): string {
  return sha256Utf8(
    headers
      .map((h) => `${String(h.number).padStart(2, "0")} ${h.title}`)
      .join("\n"),
  );
}

export function buildWholeShellProof(input: {
  logText: string;
  expectedLogSha256: string;
  expectedLogBytes: number;
  seamScriptText: string;
  expectedStageCount?: number;
  finalStageTitleMustInclude?: string;
  releaseBoundaryStageTitlePrefix?: string;
}): WholeShellProof {
  /*
    PRE-DEPLOY AUDIT — 38 -> 40. The canonical sequence gained two stages: the
    D088 real-PostgreSQL migration seam and the automation-OFF readback, both
    of which existed as npm scripts that the canonical shell never ran. The
    default moves with the script, and the retained log + ledger were
    REGENERATED from a fresh whole-shell run rather than re-pinned — a count
    edited without a run behind it is the one thing this proof exists to catch.
  */
  const expectedStageCount = input.expectedStageCount ?? 40;
  const finalStageTitleMustInclude =
    input.finalStageTitleMustInclude ?? "Release owner references are current";
  const releaseBoundaryStageTitlePrefix =
    input.releaseBoundaryStageTitlePrefix ??
    "Ordinary deploy refuses a cutover-required release";

  // 1. The retained log must be byte-identical to what the ledger recorded.
  const logSha256 = sha256Utf8(input.logText);
  const logBytes = Buffer.byteLength(input.logText, "utf8");
  if (logSha256 !== input.expectedLogSha256) {
    throw new Error(
      `whole-shell proof refused: log sha256 ${logSha256} != expected ${input.expectedLogSha256}`,
    );
  }
  if (logBytes !== input.expectedLogBytes) {
    throw new Error(
      `whole-shell proof refused: log bytes ${logBytes} != expected ${input.expectedLogBytes}`,
    );
  }

  // 2. Ordered headers from the log.
  const headerRe = /^\[verify-db-seams\] ── (\d{2}) (.+)$/gm;
  const headers: WholeShellHeader[] = [];
  for (const match of input.logText.matchAll(headerRe)) {
    headers.push({ number: Number(match[1]), title: match[2]!.trim() });
  }
  if (headers.length !== expectedStageCount) {
    throw new Error(
      `whole-shell proof refused: ${headers.length} stage headers found, expected ${expectedStageCount}`,
    );
  }
  headers.forEach((header, index) => {
    if (header.number !== index + 1) {
      throw new Error(
        `whole-shell proof refused: header[${index}] is number ${header.number} — sequence must be exactly 01..${expectedStageCount} in order (missing/duplicate/out-of-order)`,
      );
    }
  });

  // 3. Source equality against the CURRENT seam script's stage declarations.
  const scriptTitles: string[] = [];
  for (const match of input.seamScriptText.matchAll(/^stage "((?:[^"\\]|\\.)*)"/gm)) {
    scriptTitles.push(match[1]!.replace(/\\"/g, '"').trim());
  }
  if (scriptTitles.length !== expectedStageCount) {
    throw new Error(
      `whole-shell proof refused: seam script declares ${scriptTitles.length} stages, expected ${expectedStageCount}`,
    );
  }
  scriptTitles.forEach((title, index) => {
    if (title !== headers[index]!.title) {
      throw new Error(
        `whole-shell proof refused: stage ${index + 1} title mismatch — log "${headers[index]!.title}" vs script "${title}"`,
      );
    }
  });
  const headerDigestFromLog = digestHeaders(headers);
  const headerDigestFromScript = digestHeaders(
    scriptTitles.map((title, index) => ({ number: index + 1, title })),
  );
  if (headerDigestFromLog !== headerDigestFromScript) {
    throw new Error("whole-shell proof refused: header digests diverge");
  }

  // 4. Release-owner must be the LAST stage.
  const last = headers[headers.length - 1]!;
  if (!last.title.includes(finalStageTitleMustInclude)) {
    throw new Error(
      `whole-shell proof refused: final stage ${last.number} "${last.title}" is not the release-owner stage`,
    );
  }

  // 5. Exact final PASS line.
  const lines = input.logText.split("\n").filter((line) => line.trim() !== "");
  const finalPassLine = lines[lines.length - 1]!;
  const expectedPass = `[verify-db-seams] PASS — ${expectedStageCount} stages`;
  if (finalPassLine !== expectedPass) {
    throw new Error(
      `whole-shell proof refused: final line "${finalPassLine}" != "${expectedPass}"`,
    );
  }

  // 6. Release-boundary evidence from the boundary stage's own log segment.
  const boundary = headers.find((header) =>
    header.title.startsWith(releaseBoundaryStageTitlePrefix),
  );
  if (!boundary) {
    throw new Error(
      "whole-shell proof refused: release-boundary stage header absent",
    );
  }
  const boundaryHeaderLine = `[verify-db-seams] ── ${String(boundary.number).padStart(2, "0")} ${boundary.title}`;
  const start = input.logText.indexOf(boundaryHeaderLine);
  const next = headers[boundary.number] // header AFTER the boundary (0-indexed array)
    ? input.logText.indexOf(
        `[verify-db-seams] ── ${String(boundary.number + 1).padStart(2, "0")} `,
      )
    : input.logText.length;
  const excerpt = input.logText.slice(start, next === -1 ? undefined : next);
  const markerLine = excerpt
    .split("\n")
    .find(
      (line) =>
        line.startsWith("no cutover pending:") ||
        line.startsWith("cutover pending:"),
    );
  if (!markerLine) {
    throw new Error(
      "whole-shell proof refused: CUTOVER_REQUIRED marker/manifest agreement line absent from the boundary stage segment",
    );
  }
  const deployGateOrderingPassPresent = excerpt.includes(
    "[deploy-gate-ordering] PASS",
  );
  if (!deployGateOrderingPassPresent) {
    throw new Error(
      "whole-shell proof refused: deploy-gate-ordering PASS absent from the boundary stage segment",
    );
  }

  return {
    stageHeaderCount: headers.length,
    headers,
    sequenceValid: true,
    headerDigestFromLog,
    headerDigestFromScript,
    sourceEquality: true,
    releaseOwnerLast: last,
    finalPassLine,
    logSha256,
    logBytes,
    releaseBoundary: {
      stageNumber: boundary.number,
      stageTitle: boundary.title,
      markerManifestAgreementLine: markerLine,
      deployGateOrderingPassPresent,
      excerpt: excerpt.slice(0, 4000),
    },
  };
}

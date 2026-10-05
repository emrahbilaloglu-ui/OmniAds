import { request } from "node:http";
import { join } from "node:path";
import type { NativeArchiveGeneration } from "../../lib/creative-decision-engine/native-evidence-archive";
import { need, readExact, same, sha256, UUID } from "./common";

/** Fresh historical HTTP proof. `freshHistoricalHttpMatches` may be true ONLY
 * from an actual HTTP 200 response whose complete body bytes are on disk and
 * re-hashed here, parsed here, and match the frozen original row bytes with
 * every authority flag false. A reader FUNCTION call is never this proof.
 * transport "owned-http-fixture" = real HTTP to the owned route fixture;
 * "chrome-authenticated" = bodies saved from the operator's authenticated
 * Chrome session against the live route (live gate; never produced here). */
export const HTTP_PROOF_CONTRACT = "native-historical-http-proof.v1" as const;
export const HTTP_PROOF_MAX_AGE_MS = 10 * 60_000;
export const EVIDENCE_ROUTE = "/api/creatives/decision-engine-v3/evidence";
export interface Sample { evaluationId: string; providerAccountId: string; adId: string }
export function evidencePath(g: NativeArchiveGeneration, s: Sample) {
  const q = new URLSearchParams({ businessId: g.businessId, providerAccountId: s.providerAccountId, adId: s.adId, asOf: g.asOfDate,
    view: "historical", archiveJobRunId: g.jobRunId, evaluationId: s.evaluationId, engineVersion: g.engineVersion });
  return `${EVIDENCE_ROUTE}?${q.toString()}`;
}
export function httpGet(port: number, path: string, timeoutMs = 15_000) {
  return new Promise<{ status: number; cacheControl: string; body: Buffer; complete: boolean }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on("data", (c: Buffer) => { bytes += c.length; if (bytes > 512 * 1024) { req.destroy(); reject(new Error("HTTP_BODY_BOUND")); } else chunks.push(c); });
      // "complete" = the response stream ended AND the body length equals the declared content-length.
      res.on("end", () => { const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, cacheControl: String(res.headers["cache-control"] ?? ""), body,
          complete: res.complete && Number(res.headers["content-length"]) === body.length }); });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("HTTP_DEADLINE"))); req.on("error", reject); req.end();
  });
}
export interface HttpProofRecord { evaluationId: string; path: string; httpStatus: number; cacheControl: string; bodyFile: string; bodyBytes: number;
  bodySha256: string; networkLoadingFinished: boolean }
export interface HttpProof { contract: typeof HTTP_PROOF_CONTRACT; transport: "owned-http-fixture" | "chrome-authenticated";
  purpose: string; jobRunId: string; rootSha256: string; sourceManifestSha256: string; actualSourceReviewSha256: string;
  observedAt: string; liveRoute: boolean; requests: HttpProofRecord[] }

/** Re-derives the verdict from the saved bodies; declared fields are only checked against them. */
export async function verifyHttpProof(proofDirectory: string, expect: { purpose: string; jobRunId: string;
  rootSha256: string; sourceManifestSha256: string; actualSourceReviewSha256: string; generation: NativeArchiveGeneration; samples: Sample[];
  rowSha256: Record<string, string>; activatedAt: string; nowMs: number; allowOwnedFixture: boolean }) {
  const proofBytes = await readExact(join(proofDirectory, "proof.json"), 256 * 1024);
  const proof = JSON.parse(proofBytes.toString("utf8")) as HttpProof;
  need(proof.contract === HTTP_PROOF_CONTRACT && proof.purpose === expect.purpose && proof.jobRunId === expect.jobRunId &&
    proof.rootSha256 === expect.rootSha256 && proof.sourceManifestSha256 === expect.sourceManifestSha256 &&
    proof.actualSourceReviewSha256 === expect.actualSourceReviewSha256, "HTTP_PROOF_BINDING");
  need(proof.transport === "chrome-authenticated" ? proof.liveRoute === true : expect.allowOwnedFixture && proof.transport === "owned-http-fixture" && proof.liveRoute === false,
    "HTTP_PROOF_TRANSPORT");
  const at = Date.parse(proof.observedAt);
  need(Number.isFinite(at) && at >= Date.parse(expect.activatedAt) && at <= expect.nowMs && expect.nowMs - at <= HTTP_PROOF_MAX_AGE_MS, "HTTP_PROOF_NOT_FRESH");
  // Non-empty, de-duplicated, exactly the captured samples of THIS original.
  const ids = proof.requests.map(r => r.evaluationId);
  need(ids.length > 0 && new Set(ids).size === ids.length && expect.samples.length > 0 &&
    same([...ids].sort(), expect.samples.map(s => s.evaluationId).sort()), "HTTP_PROOF_SAMPLE_SET");
  for (const r of proof.requests) {
    const sample = expect.samples.find(s => s.evaluationId === r.evaluationId)!;
    need(r.path === evidencePath(expect.generation, sample) && r.httpStatus === 200 && r.networkLoadingFinished === true && /no-store/.test(r.cacheControl) &&
      /^[a-f0-9-]{36}\.body$/.test(r.bodyFile) && r.bodyFile === `${r.evaluationId}.body`, "HTTP_PROOF_REQUEST");
    const body = await readExact(join(proofDirectory, r.bodyFile), 512 * 1024);
    need(body.length === r.bodyBytes && sha256(body) === r.bodySha256, "HTTP_PROOF_BODY_BYTES");
    const evidence = JSON.parse(body.toString("utf8"));
    need(evidence?.status === "historical_available" && evidence.authority === "historical_read_only" && evidence.providerAuthority === false &&
      evidence.currentDecisionEligible === false && evidence.reclaimEligible === false && same(evidence.generation, expect.generation) &&
      evidence.identity?.evaluationId === r.evaluationId && UUID.test(r.evaluationId) &&
      typeof evidence.rowJson?.evaluation === "string" && sha256(evidence.rowJson.evaluation) === expect.rowSha256[r.evaluationId],
    "HTTP_PROOF_BODY_ORIGINAL_MISMATCH");
  }
  return { matches: true as const, proofSha256: sha256(proofBytes),
    transport: proof.transport, liveRoute: proof.liveRoute, requests: proof.requests.length };
}

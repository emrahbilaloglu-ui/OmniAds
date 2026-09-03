/**
 * D085 — the real six-business budget-proposal DRY RUN replay.
 *
 * WHAT THIS PROVES. For every real binding and direction in the charter scope,
 * it runs the canonical D085 dry-run contract over the pinned D080B/D083/D084
 * evidence and publishes the exact funnel: how many candidates existed, where
 * each one stopped, and what would have been sent if anything had survived.
 *
 * THE EXPECTED ANSWER IS ZERO, AND IT MUST BE NON-VACUOUS. D083 already proved
 * 0 of 41,242 entity-origin pairs reach intent-ready — every one of the 32,859
 * that survived scope, hierarchy, ownership and schedule dies on
 * `currency_exponent_not_captured`. D084 proved 0 of 247,050 evaluated
 * proposals are strictly eligible and that no canonical profile output is
 * retained for any of the 18 business-action pairs. D085 does not soften
 * either result: it shows the stage-by-stage funnel and the exact blockers so
 * the zero is a derived finding rather than a refusal.
 *
 * NO DATABASE, NO PROVIDER, NO WRITE. Every fact is read from a pinned file
 * whose bytes are hashed before parsing. This module imports no DB client, no
 * provider adapter and no write path; the assembler, replay and verifier are
 * pure functions of the pinned bytes.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { canonicalDigest } from "@/scripts/audits/d080-meta-budget-edit-evidence";
import { PIT_POLICY } from "@/lib/meta/point-in-time-policy";
import { exactMap, renderProblems, safeSnapshot, type SchemaProblem } from "@/lib/meta/runtime-schema";
import { checkPinnedSources, type PinnedSourceCheck } from "@/scripts/audits/d084-pinned-sources";
import {
  RECEIPT_VERIFICATION_GUARANTEE,
  PREVIEW_CONTRACT_VERSION,
  DRY_RUN_BLOCKERS,
  D085_REVISION,
  META_BUDGET_PREVIEW_RECEIPT_REJECTED_VERSIONS,
  META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
  PROVIDER_CAPABILITY_TODAY,
  buildBudgetProposalDryRun,
  dryRunPolicyFingerprint,
  unknownSafetyFlag,
  type DryRunBlocker,
  type DryRunInput,
} from "@/lib/meta/budget-proposal-dry-run";
import {
  META_PROVIDER_READBACK_CONTRACT,
  classifyReadback,
  comparePreflight,
  type PreflightAttemptOutcome,
} from "@/lib/meta/provider-readback-contract";
import { WRITE_SAFETY_STEPS, type WriteSafetyStep } from "@/lib/meta/write-safety-contract";
import type { BudgetDirection } from "@/lib/meta/budget-intent-contract";

/**
 * The audit artifact contract, derived from the SAME revision the runtime
 * proposal contract uses. r15 wrote that number twice — here and in
 * `lib/meta/budget-proposal-dry-run.ts` — so the two could drift in silence.
 */
export const D085_CONTRACT_ID = `d085.budget-proposal-dry-run.v${D085_REVISION}` as const;

/**
 * THE OUTPUT PATH IS DERIVED FROM THE CONTRACT VERSION, not maintained beside
 * it.
 *
 * Correction 11 advanced the contract identifiers and left this constant
 * naming `…r11.json`. Two `assemble` runs then overwrote a frozen, already
 * independently-verified artifact in place. Advancing a version and advancing
 * the artifact PATH were two edits, and doing the first without the second
 * pointed the generator at history.
 *
 * They are one edit now. The revision is parsed out of the contract id, so the
 * path cannot lag the version, and `D085_FROZEN_ARTIFACTS` below is the
 * explicit refusal list checked before any write.
 */
/**
 * THE REPOSITORY ROOT, derived from this module's own location.
 *
 * r12 claimed "trusted paths resolve canonically rather than against cwd" and
 * then used `resolve(path)`, which is cwd-relative — so `process.cwd()`
 * controlled every pinned read. Worse, the Correction 11 test changed cwd to
 * `/` and asserted an ENOENT failure, which ENSHRINED the bug as expected
 * behaviour. A valid artifact must verify from ANY working directory.
 *
 * This module lives at `<root>/scripts/audits/`, so the root is two levels up
 * from its own directory. It is immutable and independent of cwd.
 */
export const D085_REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Resolve a repo-relative path against the canonical root, never cwd. */
export function d085TrustedPath(relative: string): string {
  return join(D085_REPO_ROOT, relative);
}

/**
 * THE ONE TRUSTED READER, injected wherever a predecessor accepts one.
 *
 * `checkPinnedSources` already takes a reader, so D085 supplies this instead
 * of D084 being modified to suit D085. Every trusted byte D085 reads comes
 * through here, resolved against the canonical repo root rather than cwd.
 */
export function d085TrustedReader(relative: string): Buffer {
  return readFileSync(d085TrustedPath(relative));
}

export const D085_ARTIFACT_DIR = "docs/audits/generated";
export const D085_ARTIFACT_STEM = "d085-budget-proposal-dry-run-2026-09-01";

/** The trailing `vN` of the contract id, which names the artifact revision. */
export function d085RevisionOf(contractId: string): number {
  const m = /\.v(\d+)$/.exec(contractId);
  if (!m) throw new Error(`the D085 contract id ${JSON.stringify(contractId)} carries no trailing .vN revision`);
  return Number(m[1]);
}

/** `…r<N>.json` for revision N; the first pass (v1) has no suffix. */
export function d085ArtifactPathFor(revision: number): string {
  return revision <= 1
    ? `${D085_ARTIFACT_DIR}/${D085_ARTIFACT_STEM}.json`
    : `${D085_ARTIFACT_DIR}/${D085_ARTIFACT_STEM}.r${revision}.json`;
}

export const D085_JSON_OUT = d085ArtifactPathFor(d085RevisionOf(D085_CONTRACT_ID));

/**
 * The pre-write gate. Returns the path to write, or throws BEFORE any
 * filesystem contact if the target is frozen history.
 */
export function assertWritableArtifactPath(target: string): string {
  const normalised = target.replace(/^\.\//, "");
  if (D085_FROZEN_ARTIFACTS.includes(normalised)) {
    throw new Error(
      `refusing to write ${normalised}: it is a frozen, already-rejected D085 artifact. ` +
      `The assembler writes only ${D085_JSON_OUT} for contract ${D085_CONTRACT_ID}.`,
    );
  }
  if (normalised !== D085_JSON_OUT) {
    throw new Error(
      `refusing to write ${normalised}: the only permitted output for contract ${D085_CONTRACT_ID} is ${D085_JSON_OUT}.`,
    );
  }
  return normalised;
}

/**
 * THE ONE CANONICAL SET OF REJECTED PASSES.
 *
 * Every rejected D085 pass is recorded here exactly once. Its contract id, its
 * artifact path, the frozen-artifact refusal list, the lineage the artifact
 * publishes and the named `D085_REJECTED_*` constants below are all DERIVED
 * from these records.
 *
 * r15 kept the file digests in two places — these records and a second
 * hand-maintained `D085_REJECTED_LINEAGE` literal. The two disagreed: the
 * lineage carried a 63-character v2 digest with a dropped `f`, and the verifier
 * compared the artifact only against that wrong copy. A fact recorded twice is
 * a defect, and hashes are not an exception.
 */
export interface D085RejectedPass {
  readonly revision: number;
  readonly contract: string;
  readonly path: string;
  readonly fileSha256: string;
  readonly artifactHash: string | null;
  readonly snapshotHash: string | null;
  readonly analysisHash: string | null;
  readonly status: "rejected";
  readonly why: string;
}

function rejectedPass(input: {
  revision: number; fileSha256: string; why: string;
  artifactHash?: string; snapshotHash?: string; analysisHash?: string;
}): D085RejectedPass {
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new Error(`a rejected pass needs a positive integer revision, got ${String(input.revision)}`);
  }
  // FORM, checked where the record is authored. The r15 defect was a digest
  // one character short; nothing in the build ever looked at its shape.
  if (!/^[0-9a-f]{64}$/.test(input.fileSha256)) {
    throw new Error(
      `the r${input.revision} file digest is not a lowercase 64-hex SHA-256: ` +
      `${JSON.stringify(input.fileSha256)} (${input.fileSha256.length} characters)`,
    );
  }
  return Object.freeze({
    revision: input.revision,
    contract: `d085.budget-proposal-dry-run.v${input.revision}`,
    path: d085ArtifactPathFor(input.revision),
    fileSha256: input.fileSha256,
    artifactHash: input.artifactHash ?? null,
    snapshotHash: input.snapshotHash ?? null,
    analysisHash: input.analysisHash ?? null,
    status: "rejected",
    why: input.why,
  });
}

export const D085_REJECTED_PASSES: readonly D085RejectedPass[] = Object.freeze([
  /*
    The first pass, pinned as REJECTED history — never as accepted truth.

    Codex rejected it for fail-open freshness, fail-open PIT/decision clocks,
    unknown safety manufactured as `false`, a provider ledger that counted local
    route probes as provider reads, and a preview branch no test could reach.

    (This comment sat above the r14 record until Correction 15 — it describes
    the first pass and always did.)
  */
  rejectedPass({
    revision: 1,
    fileSha256: "4f728bef6c91ac5345d4f3b7c44c262c647f734d2c12547cef7dc4343bf4d18c",
    why:
      "fail-open preflight freshness and projection completeness; fail-open decision clocks and no PIT ordering; boolean safety with unknown written as false; providerReadsAttempted=3 counting local route probes as provider contact; and an unreachable preview branch with no instantiating test",
  }),
  rejectedPass({
    revision: 2,
    fileSha256: "0495c156fcc2cf84eacf6c1a93b0efd7ac5fda2bcaed1159c5696181732af86d",
    artifactHash: "ea5a825592877d6523ddfa6119d049e96a3d828fe179278a34f7ab595d665495",
    why:
      "semantically fail-open projection validation (cross-grain and not_applicable owner modes, garbage and reversed lifetime flights, Date.parse rollover); a dry run that bound none of its evidence, so one input with a wrong account, wrong entity, 900x wrong amount, contradicting direction/action, whitespace decision identity and a self-contradictory preflight produced only the structural blocker; unavailable governance rendered as a proved-clear kill switch and an unavailable admission dimension as a proved incident; an input fingerprint omitting `capability`; an unfrozen, unhashed preview whose idempotency key was the durable intent key verbatim; and 33,774 entity-origin-direction evaluations published under the name `candidatePairsTotal`",
  }),
  rejectedPass({
    revision: 3,
    fileSha256: "2848f8423b1875ddc2ab9d6910ce64172e2a29fc1478b53cb4246b50c45a4220",
    artifactHash: "41809b707646b99c6318eb379484c3eed74752e71ab52f2c96d20b5a571725c0",
    why:
      "runtime identity and enums unvalidated, so a projection naming not-an-account/not-an-adset with BANANA status and optimization goal returned complete:true and then confirmed/provesApplied; Date.parse rollover let observedAt 2026-02-30 prove freshness at ageSeconds:10; the preflight summary was trusted rather than re-derived, with no raw attempt, ignored evaluatedAt and an optional baseline fingerprint; cross-binding accepted a non-hex decision hash and an unvalidated intent cast; safety provenance failed open on blank source, null/rollover/future as-of; and the input fingerprint omitted intent.idempotencyKey while using insertion-order-sensitive JSON.stringify",
  }),
  rejectedPass({
    revision: 4,
    fileSha256: "992f0a599a6ddf41131511023b20112973fd502a9c2db8acffa13d1035b65dc9",
    artifactHash: "dc3bef60dc9e66baba54a714c8a0b36f3b791abdcc95d356507c1793da866b42",
    why:
      "a cast ValidatedBudgetIntent was still trusted, so a forged proposedMinorUnits of 999,999 on a 10% change from 10,000, a forged USD exponent of 3, intent clocks after the origin, an empty sourceFingerprints object, arbitrary intentKey/idempotencyKey and a reversed evidence window each reached would_write_available with an EMPTY blocker list; the preflight summary was only partly re-derived, so a published ageSeconds of 10 over a 0-second-old observation previewed and a post-origin pre-knowledge observation leaked; governanceToKillSwitchFlag tested killSwitchEngaged before verification so an unverified unconfigured read returned engaged, and a safety state of \"banana\" fell through as clear; a resolved commercial verdict with a null profile contract previewed; capabilityPermitsWrite trusted typed booleans; and the receipt hash needed hidden caller-supplied capability and inputFingerprint to recompute",
  }),
  rejectedPass({
    revision: 5,
    fileSha256: "a55a091ac3cb157b5389bbc65e418129cb54fffe800d41ded0e3902da2c6799f",
    artifactHash: "cd04511913acc905e1b18a0fda608618158c3d6df21a68f471003b5f03781883",
    why:
      "TypeScript shapes, truthiness and loose projections were still treated as runtime proof, so 24 malformed variants of the shipped favourable fixture all previewed with an empty blocker list — an empty write-safety ceremony and every step 'banana' or not_applicable, an authorised intent carrying blockers, a daily intent with a lifetime flight, a resolved role sourced from manual_label or campaign_name or carrying the commercial action 'scale', an eligible commercial verdict with non-empty blockers or a null action, arbitrary currency registry strings, inferred/invalid unit confidence, an available budget fact with null observed/captured clocks or blank lineage, truthy non-boolean casts for write scope, fact availability and role resolution, and safety and decision clocks after a historical origin; governanceToKillSwitchFlag and admissionToSafetyFlag also accepted the string \"yes\" as a proved boolean, and validateCapability ignored its own requestedField argument",
  }),
  rejectedPass({
    revision: 6,
    fileSha256: "6771eb63574ba8d410809c62fc54394d93606622c2153adbf5e30d4abd311d32",
    artifactHash: "1bb5e7347ea1807afcb6dd505140e0b1316026ab0cd9460a8b328e72fb47d54b",
    why:
      "the claimed closed-world contract was not real, and 17 probes of the shipped favourable fixture proved it: the canonical intent validator bounded every clock against the ORIGIN only, so an intent declaring knowledgeAsOf 2026-08-01 while resting on effective and authority evidence stamped 2026-08-31 validated, and Correction 5's own clock test passed only because of that gap; validateRoleAuthority treated producer, satisfiesRoleAuthority, authorityBlockers and campaignId as optional and accepted any non-empty resolverVersion, so deleting each of the four, a non-array blocker container \"none\", and the arbitrary resolver identity \"banana\" all returned canonical:true without ever calling isCampaignContextResolverAuthorityValidated; commercial coherence checked `code` but never `reason`, so an eligible verdict carrying \"not eligible\" was coherent, and a non-array blockerCodes of \"none\" was read as no blockers; currencyRegistryVersion:null was treated as unspecified-but-fine so the ISO-4217 registry identity was not required; normalization was total only at the top level, so a null killSwitch, admission, cap, cooldown or conflict threw \"Cannot read properties of null (reading 'state')\" instead of blocking; and the receipt published only supportedFields and source out of the five capability values its fingerprint covers, with nothing comparing snapshot to fingerprint, so a receipt forged to claim a permissive capability and re-hashed self-verified as true",
  }),
  rejectedPass({
    revision: 7,
    fileSha256: "b9e65b3d885fe2eb852c6ad2ed181a420cf66c2a6a33b29cab543ab7dd592c02",
    artifactHash: "c6de0030cfde880419bb71031ee1f3befb649de609bbdc61fa98c4b099b70c3f",
    snapshotHash: "8927546a5c59764ddfa5a6c360316be73c9e0b44beabe092b2164ef310b8fbf8",
    analysisHash: "de6182bf379f26699b0f76e0d8ca93db87e2bde160c826a867b673e5bed027c0",
    why:
      "the closed world was never tested against a REACHABLE positive baseline: the canonical campaign-context resolver identity is environment-approved and this environment approves none, so every r7 negative row rested on the authority floor rather than on the gate it named. Approving the resolver for one process made the baseline non-vacuous (would_write_available, empty blocker list) and 11 of 12 adversarial probes escaped. (1) validateRoleAuthority checked only that campaignId was a non-empty string and the builder compared role business and account to the proposal scope but never the campaign, so a role resolved for campaign 23850000000000000 authorised a proposal against 23859876543210987 under the same account and previewed, contradicting D081 requiresExactCompositeScope; the role as-of was likewise only required to parse, so a resolution dated 2026-01-01 authorised a 2026-09-01 origin. (2) capabilityFingerprint hashed a sorted but NOT de-duplicated caller object while the published snapshot was de-duplicated, so a capability carrying [\"lifetime_budget\",\"daily_budget\",\"daily_budget\"] assembled, shipped the promised [\"daily_budget\",\"lifetime_budget\"], and then failed its own verifier — a genuine receipt could not reproduce its own fingerprint. (3) verifyReceiptPreviewIntegrity validated boolean SHAPE and never capability PERMISSION, so setting both published booleans to false, re-fingerprinting from that false snapshot and re-hashing returned verified:true — a receipt asserting that neither the budget endpoint nor the dispatch verb exists, verifying as a valid would-write receipt. (4-8) validateBudgetIntent guarded its blocker rule with Array.isArray and then spread the raw value during construction, so rawIntent.blockerCodes of null, undefined, 7 or {} threw \"input.blockerCodes is not iterable\" and the string \"none\" was spread into the characters n/o/n/e and PREVIEWED. (9-10) preflight.rejections and preflight.driftedFields set to null threw \"Cannot read properties of null (reading 'length')\". (11) commercial.blockerCodes:null threw the same way as soon as the coherent companion state evidenceFloorsClear:false selected the message-building branch. Correction 6 also edited scripts/audits/d084-commercial-target-evidence.test.ts, violating the D079-D084 byte-for-byte preservation rule, to absorb timeouts it had caused by running six audit suites concurrently against a one-worker limit",
  }),
  rejectedPass({
    revision: 8,
    fileSha256: "6652bc4b599f3281ae1f4fde63a8584f23835ad2fce09208908ae2c59d98e260",
    artifactHash: "2200df84ded3884dc86170461921349895231a317e0a89b598aa81c2238c6649",
    snapshotHash: "984c17c2619cf3684400e514eab96967d46718c68efe2ec540f70f6265e750e7",
    analysisHash: "f8078bf7f685f824287e41a791ba0ea26350ec632b8ca1d8bf08fb1326f51c3f",
    why:
      "66 independently reproduced escapes against a reachable positive baseline (both grains previewing with an empty blocker list). (A) 41 self-consistent, re-hashed request/receipt forgeries returned verified:true, because verifyReceiptPreviewIntegrity checked capability semantics and a caller-recomputable SHA and NOTHING about what the request and receipt say: dryRun:false, executable:true, providerWriteAttempted:true, providerOutcome:\"succeeded\", readbackClassification:\"succeeded\", executionState:\"executable\", ctaEnabled:true, isDurableReceipt:true, a human actor with a non-null humanApproval, every redaction flag set true, a durable-looking previewKey and idempotencyKeyPreview, an emptied fieldAllowlist, relative_delta value semantics, mismatched entity/amounts/currency/exponent between request and receipt, a CAS precondition disagreeing with the receipt baseline, a rollback that restores the wrong amount, an emptied gatesSatisfied with every step missing, and extra keys including accessToken on the request, dispatchApproved on the receipt and one on the capability snapshot. (B) 8 exported boundaries threw instead of returning a verdict: validateBudgetIntent(null, []), assembleWouldWritePreview(null), and assembly inputs with a null capability, scope, intent, casBaseline or writeSafety, plus verifyReceiptPreviewIntegrity(null) — despite assembleWouldWritePreview documenting itself as \"pure and total\". (C) 15 exact-map and malformed-element mutations previewed with an EMPTY blocker list — an extra key on scope, role, budgetFact, commercial, a safety child, capability, decision, a knownBindings element, casBaseline, preflight, preflightEvidence, rawAttempt, rawIntent and rawIntent.evidenceWindow, and a non-string element in intentRejections — although Correction 7 claimed every required map was exactly its canonical keys. (D) a succeeded raw attempt whose nested projection was null or missing threw TypeError: Cannot read properties of null (reading 'providerAccountId') inside the frozen validateProjection, because the nested projection map was never inventoried. Correction 7 also overstated the guarantee: an ordinary SHA over the payload proves deterministic serialization, not authenticity, and cannot detect an actor who edits the payload and recomputes the hash",
  }),
  rejectedPass({
    revision: 9,
    fileSha256: "3442f8c5ff506ee036ac549317702c6f7ff7c3f68a19abbfc94b4d77aae1565a",
    artifactHash: "bc83de0d36ec307152917222c30f04d3add11553684ea76cc3cdfb5111c9a2dc",
    snapshotHash: "331ae4b2d6771c4d694555a94375ced3afee18fba326a05a5efa453222ed1fe3",
    analysisHash: "320d5f929d580aeba1c8d434df119971b2ae9d2d33c91e0a31138840404cf3fe",
    why:
      "32 independently reproduced escapes against a reachable positive baseline at both grains. (A) runtime exactness and totality were not established: the schema layer probed required keys with `key in value`, which reaches through the PROTOTYPE, while extras and hashing used own enumerable keys, so a crafted object with an inherited required field produced no schema problem; an arbitrary prototype passed as a plain map; accessors, symbols and non-enumerable own properties had no safe data model; a Proxy ownKeys trap threw; and BigInt threw `Do not know how to serialize a BigInt` at assembleWouldWritePreview, verifyReceiptPreviewIntegrity, buildBudgetProposalDryRun, recomputePreviewHash and capabilityFingerprint, while a cycle threw `Maximum call stack size exceeded`. (B) receipt/request semantics were fail-open: 12 internally coherent, self-rehashed pairs verified as true — blank and numeric entity ids on both sides, a `banana` receipt grain, accountIsWriteScope:false, blank business and provider identity, a NEGATIVE amount copied coherently through request/CAS/before/rollback, fractional proposed minor units, a blank currency, a negative currency exponent, a blank actor.module, a non-string decisionId and an arbitrary readback fingerprint; and 4 direct assembly calls returned a preview when they had to refuse — a fabricated minimal intent carrying only amounts/currency/key fields, an EMPTY write-safety ceremony, a scope explicitly outside write scope, and blank business/provider identity. (C) point-in-time leakage remained: budgetFact.capturedAt of `not-an-instant` still previewed because non-empty was treated as provenance and the ordering loop silently skipped unparseable values, and a canonically VALID date-only raw intent dated 2026-09-01 previewed against an outer knowledge cutoff of 2026-08-31T23:59:59.000Z, a later calendar day leaking across an earlier instant cutoff. (D) the artifact verifier did not verify the artifact: replacing the top-level artifactHash, downgrading snapshot.contract to v1, downgrading analysis.contractVersion to v1, emptying analysis.writeSafetyCensus, and removing the first sourceManifest entry EACH returned ok:true with failures [] — no hash was ever recomputed. (E) evidence and prose overclaimed: the r9 report stated RECEIPT_VERIFICATION_GUARANTEE was published in the generated artifact and it was absent entirely; the zero-provider-contact claim was derived from a hard-coded probe constant and re-derived by generator and verifier from that same constant, then described as independent proof; the artifact limit text said unknown safety flags are recorded false so no blocker is inflated while the implementation records unknown and every replay cell carries unverified blockers; and the rejected-version list stopped at v5 while the contract was already v9",
  }),
  rejectedPass({
    revision: 10,
    fileSha256: "3c73cc02866f1b39b3deacfc46bb2b669bb34f4d6ab93109b71c886825342185",
    artifactHash: "b0da05c71b1420aee911d4d700e7b04bb4ce63da172d5b62f9561dbdbe4b2525",
    snapshotHash: "a605b772834f33c49e62a50dc697961c0dd11e3479001ebf21ed455f1ca649bb",
    analysisHash: "8d1c47b9991b771b9d881025fccd5b7d5333ac87ab7074c02175add9d91efbe0",
    why:
      "35 independently reproduced local contract failures against a reachable positive baseline at both grains. (A) six safe-snapshot failures: an own enumerable data property named __proto__ returned ok:true while the snapshot silently LOST the key (the output was a plain object literal, so the inherited setter swallowed it); a non-enumerable array element at index 0, an enumerable own array key 01, and an enumerable own array key 4294967295 each returned ok:true, because array indices were matched with a digits-only regex instead of the canonical index rule and length was read from arr.length AFTER observation rather than from the captured descriptor; a Proxy whose get trap throws for length escaped as an uncaught Error: length trap because only the three reflection calls were contained; and a Proxy ownKeys trap throwing a non-Error whose message is a throwing getter escaped as Error: secondary message trap, because the error-rendering path interpolated (error as Error).message and thereby invoked caller code. (B) twelve authoritative-assembly failures: starting from a full-shaped validated intent, authorityStatus \"unauthorised\", blockerCodes [authority_missing], a blank intentKey, a blank durable idempotencyKey, a blank currency, currencyExponent -1, a zero-change proposal made coherent through delta and readback, an inconsistent rollback.priorMinorUnits, an inconsistent readback.expectedMinorUnits, a configStateHash of not-a-hash, and a switched parentCampaignId on either the intent scope or the CAS baseline ALL returned a preview — the boundary checked only the top-level key set, the contract, the execution state, a small scope subset and integer amounts, which is not canonical derivation. (C) five receipt-domain failures verified true after coherent re-hashing: an arbitrary actor.module, an arbitrary inputFingerprint, a previewKey and an idempotencyKeyPreview that kept only their namespace prefixes, and a blank scope.business. (D) twelve artifact-verifier failures: eight coherently re-sealed material changes returned ok:true with failures [] — an extra top-level unrecognisedSection, an emptied analysis.writeSafetyCensus, a rewritten pointInTimePolicy.ordering, a removed receiptLineage, a verificationGuarantee replaced by minimally non-empty arbitrary prose, rewritten providerContactEvidence prose, rewritten rejectedLineage hashes and statuses, and replaced analysis.limits; a ninth kept the manifest key d079 while pointing its path at package.json with both hashes set to that file's hash, because the verifier trusted an artifact-supplied filesystem path; and three malformed inputs threw instead of returning a failure — verifyArtifact(null), a root Proxy throwing on get, and sourceManifest: null. (E) one documentation inconsistency: a source comment still described the superseded end-of-day date-only interpretation while the published policy is coarser day-to-day comparison",
  }),
  rejectedPass({
    revision: 11,
    fileSha256: "245dcfac0ef48eae9e9962774edbabce3c8fb0567805646f0a99d0de6f025d00",
    artifactHash: "cbfd9c9918a292e2491cb2ef1f1e85450751359defedbe90994742ddbd2fbc1e",
    snapshotHash: "6ba00abf513cba4382a8956cefa4c067d6cc83ae1b6f9bfb4b68030f185cf111",
    analysisHash: "18632238774de0f383988335ad70e514adc6685f99243fd6c15b3f2ecbedc29f",
    why:
      "42 executable failures plus one static resource-exhaustion defect, all independently reproduced. (A) the artifact verifier enforced its exact schema at the TOP LEVEL only and then dereferenced nested paths on trust: 19 null substitutions — provenance, bindings, bindings[0], providerPreflight and each of its localRouteProbes/providerContacts/readbackAttempts sub-maps, localRouteProbes.statuses, localRouteProbes.methods, reconciliation, cells, cells[0], perBusiness, perAccount, perDirection, funnel, blockerCensus, readback, exposure — each threw TypeError instead of returning {ok:false}, and 6 coherently resealed extra keys (snapshot, analysis, provenance, reconciliation, providerPreflight, bindings[0]) returned ok:true with zero failures. The redaction step ended with JSON.stringify(artifact) on the CALLER's value rather than the owned snapshot, so a Proxy satisfying the descriptor-based observation and throwing on a later get escaped the boundary, breaking the asserted single-observation guarantee. checkPinnedSources and the D083/D084 reads sat outside containment and resolved relative paths against process cwd, so verifying from another directory threw ENOENT. A reversed sourceManifest, coherently resealed, verified clean because ordering was never canonical. (B) receipt/assembly: assembly accepted a foreign.contract inputFingerprint and minted a receipt its OWN verifier rejected, so assembly and verification did not share one invariant set; recomputePreviewHash threw on {} and {request:null,receipt:null} and — worse — returned a canonical-looking meta.budget-preview-receipt.v8:<64hex> for {request:{},receipt:{}}; and 10 coherently rehashed in-domain substitutions still verified: another well-formed previewKey, another well-formed idempotencyKeyPreview, another well-prefixed D085 inputFingerprint, foreign.contract CAS fingerprints on both sides, a foreign readbackFingerprint, currency ZZZ, USD exponent 3, an ad-set receipt with a null parentCampaignId, a reversed fieldAllowlist and a reversed gatesSatisfied — because verification validated SHAPE and AGREEMENT while sorting canonical collections before comparing them. The coverage ledger enumerated top-level keys only and classified previewKey, idempotencyKeyPreview and inputFingerprint as derivable while the receipt carried no material to derive them from, alongside a 'zero opaque fields' claim that was therefore untrue. (C) safeSnapshot bounded only DEPTH: it accepted a caller-declared array length up to 4,294,967,295 and then allocated and iterated proportionally, so one small object could exhaust CPU and RAM",
  }),
  rejectedPass({
    revision: 12,
    fileSha256: "7c992a40267142d959d1ee0786e7d15cf6414a685a5d2a76f236883da249070d",
    artifactHash: "c394c387f684aa4c12b4e2437a970ea981787304a5922fc7fef41133c381c78d",
    snapshotHash: "3cf5b3aee0ce0ad3905a4c9782a7c6c99528cbd6ff6c2e881de8c74bac390006",
    analysisHash: "de37501078d8566ce27d28f0501dd0c7babc29489f27daa22ab07ef2c6d15468",
    why:
      "12 independently reproduced findings; r12's own tests were green, which is exactly why they were insufficient. (A) safeSnapshot's resource contract was denominated in the wrong unit and applied to half the data: stringBytes accumulated string.length (UTF-16 code units), so 4,200,000 two-byte characters — 8,400,000 UTF-8 bytes — passed an 8,000,000-byte budget, and object KEYS were never counted at all, so one own key of 8,000,001 ASCII bytes returned ok:true. exactMap's failure path called describe(originalValue), and describe read value.length — a SECOND observation of the caller's object through which a stateful array Proxy threw out of the boundary, on every path sharing that helper. safeSnapshot observed ownKeys TWICE (getOwnPropertyDescriptors plus getOwnPropertySymbols), so a stateful Proxy returning [\"visible\", Symbol] then [\"visible\"] returned ok:true with the symbol silently dropped; and maxKeysPerObject was enforced only after every descriptor had been requested, so a 5,000-key Proxy drove 5,000 getOwnPropertyDescriptor calls before a 512-key refusal. The published maxArrayLength of 10,000 was not the enforced bound because maxKeysPerObject of 512 also applied to dense array descriptors, so a 513-element array rejected; and maxProblems was off by one, the sentinel pushing the list to maxProblems + 1. (B) recomputePreviewHash validated only top-level key SETS, so a request and receipt carrying every required key with null values returned a canonical-looking meta.budget-preview-receipt.v9:<64hex> — a public forgery aid. keySeed.intentKeyDigest and keySeed.idempotencyKeyDigest were classified cross_bound and the preview keys described as genuinely derivable, but a coherent substitution of BOTH digests with both preview keys recomputed from them and the receipt hash resealed returned verified:true; the keys derive only RELATIVE to the attested seeds. (C) the code claimed canonical repository-root paths while using resolve(), so process.cwd() controlled every pinned read — and the Correction 11 test changed cwd to / and asserted an ENOENT failure, enshrining the bug as expected behaviour; verifyArtifact also re-ran checkPinnedSources() and re-read D083/D084 after the contained try/catch, so a later or racing I/O failure still escaped. (D) the assembler wrote through the fixed sibling path <final>.writing with writeFileSync, which follows symlinks, so a pre-existing symlink at that name could truncate a frozen artifact before the rename — the exact accident that destroyed r11, reachable deliberately",
  }),
  rejectedPass({
    revision: 13,
    fileSha256: "150277bab191a92ea68a82bf6cb258cbc8d87b9e116947679c5d1864365342cc",
    artifactHash: "d4e88e1127918a267d643ea2969331011706deea1bed8b9e4a3abd6f7360a60b",
    snapshotHash: "95cc2bcbcbf98d86cd9ea8e004914a9795c83de8a601ee2464ccf7882cb6223b",
    analysisHash: "a17edd1e56a05084647fe1fdbfcd2825cf19289c5ee59e0a56b4d0ae962d11c9",
    why:
      "two root defects, both reproduced, despite every r13 suite being green. (1) recomputePreviewHash and verifyReceiptPreviewIntegrity kept TWO rule sets that drifted: the hash function ran validateWouldWriteSemantics alone, while the exact receipt-contract check and the whole capability permission / canonicality / fingerprint layer lived separately inside the verifier. Production hashing therefore blessed pairs the verifier rejects — flipping only receipt.capabilitySnapshot.budgetEndpointExists to false returned a canonical meta.budget-preview-receipt.v10:<64hex>, and so did setting only receipt.previewContractVersion to v9; six further boundary cases (dispatchVerbExists false, empty supportedFields, an unsupported requested field, non-canonical supportedFields order, a blank capability source, a mismatched capabilityFingerprint) behaved the same. A test at lib/meta/budget-proposal-dry-run.test.ts:1882-1893 explicitly EXPECTED a false-capability receipt to receive a canonical rehash, so the suite pinned the drift and contradicted the source claim that production returns the sentinel unless the pair is legal. (2) the assembler called writeSync(fd, payload, 0, \"utf8\") ONCE and ignored the returned byte count. writeSync may write fewer bytes than requested, so a short write was closed and renamed, publishing a TRUNCATED artifact atomically; the exclusive/no-follow symlink protection was sound but is a different property from content completeness, and r13 conflated atomic rename with complete write",
  }),
  rejectedPass({
    revision: 14,
    fileSha256: "4ae8676b7a65bab4306e4960625c5c075a137c9dd91bd7363069fa0b5f1625dd",
    artifactHash: "0d5209e80f242663a071bcc006966a203aef15eb1c5b0966f9aea09c04faeb4a",
    snapshotHash: "dfd2c36fc0ae40b99ed2944da464e2140319934527d3aada5626cccc4ab55455",
    analysisHash: "b5d316ee987599ed2ff93d6dc213e10bcf06cf85c492701091f89f897556b76d",
    why:
      "seven findings, all the same disease: a rule declared in two places, or a claim made in prose but not in code. (1) the two public APIs shared the INNER rules and disagreed on the OUTER wrapper — verifyReceiptPreviewIntegrity snapshotted {request, receipt} and read its two properties while recomputePreviewHash exact-validated that wrapper, so a genuine pair plus one extra enumerable top-level key VERIFIED TRUE and hashed to the sentinel: one input, two answers. (2) evaluateHashEligibility was exported yet dereferenced its arguments directly, so a revoked Proxy, a throwing accessor on previewContractVersion and a stateful Proxy each threw out of a public boundary. (3) assembly minted with the raw canonical hash and never consulted eligibility, PRODUCING artifacts its own verifier rejects — an outer scope.accountSelectionWhy of \"\" and an outer campaign scope.parentCampaignId of \"foreign\" (with rawIntent/derived/CAS parents all null) were copied into the receipt, hashed, then refused at verification. (4) __unsafeRawCanonicalPreviewHashForTests was EXPORTED from the production runtime module, so any product module could import it and reseal an invalid pair; the guard was a scan over two hand-picked files, not an import boundary. (5) the atomic writer's catch unconditionally unlinked tempPath even when openSync had failed before this process acquired it, so an EEXIST collision deleted a file or symlink it did not own — reintroducing the harm the exclusive open existed to prevent. (6) META_BUDGET_PROPOSAL_DRY_RUN_REJECTED_VERSIONS was exported stale at v1-v5 while the contract was v14 and the artifact reported v1-v13: three declarations of one truth, two of them wrong. (7) RECEIPT_VERIFICATION_GUARANTEE.nonRecomputableFields omitted request.casPrecondition.fingerprint, receipt.casBaselineFingerprint and receipt.readbackFingerprint, which are equally opaque attested digests — the verifier holds no provider projection and checks only namespace/domain and receipt-internal equality, so a coherent replacement with any other valid meta.provider-readback.v4:<64hex> is accepted, while the prose claimed agreement with the CAS baseline and read-back origin",
  }),
  rejectedPass({
    revision: 15,
    fileSha256: "26523fcb7ab1ec09a469b6ec6777f2c93c1068033348745c456af85c6aee0862",
    artifactHash: "16a35da886c4dfc1a438484c08fe0416147d97496b8e046fc3c19ee528d81485",
    snapshotHash: "17439f003ea32fd3f81503f8c468ffb7f479e638de6d28aa82daec33a180ec68",
    analysisHash: "9c7df7af8aaae631680a298afe43ccf8d040ef8caec68d6fea18c6599491b728",
    why:
      "a published historical record that no file matched, and testability that widened write authority. (1) D085_REJECTED_LINEAGE published 0495c156cc2… as the SHA-256 of r2 while the file hashes to 0495c156fcc2… — a hand-copied literal missing an f, 63 characters where a SHA-256 has 64, with the correct value eleven lines away in the r2 record; verifyArtifact never opened a historical file, so it compared one authored constant to another and passed. (2) the claimed whole-production-graph forge-helper invariant walked four directories of eight, matched .ts/.tsx only while production here also ships .js/.mjs, omitted src, store, providers, hooks and 27 root-level files, and sat inside describe.skipIf(!RESOLVER_APPROVED) so the ordinary no-approval run skipped it. (3) atomicPublish was exported with a caller-selected finalPath, a caller-selected tempPath and a caller-supplied policy callback, and demonstrably overwrote an arbitrary file through a no-op revalidate; assertWritableArtifactPath guards runAssemble's closure, not that export. (4) contiguousRejectedVersions remained an exported production-runtime helper that threw on malformed input and existed only to build constants. (5) the comment above the rejected lineage still read 'v1 through v9' while the list held fourteen entries.",
  }),
]);

/*
  CONTIGUITY, ENFORCED AT MODULE LOAD.

  The records must be exactly revisions 1..current-1, in order. A missing or
  duplicated pass is a defect in the record, not something a reader should have
  to notice for themselves.
*/
{
  const expected = Array.from({ length: D085_REVISION - 1 }, (_, i) => i + 1);
  const observed = D085_REJECTED_PASSES.map((r) => r.revision);
  if (observed.length !== expected.length || observed.some((r, i) => r !== expected[i])) {
    throw new Error(
      `the rejected-pass records are not contiguous v1..v${D085_REVISION - 1}: got [${observed.join(", ")}]`,
    );
  }
}

function rejectedPassFor(revision: number): D085RejectedPass {
  const found = D085_REJECTED_PASSES.find((r) => r.revision === revision);
  if (!found) throw new Error(`no rejected-pass record for revision ${revision}`);
  return found;
}

/**
 * Every artifact that is FROZEN history, DERIVED from the records above. An
 * assembler run whose resolved output equals one of these refuses and writes
 * nothing.
 */
export const D085_FROZEN_ARTIFACTS: readonly string[] = Object.freeze(
  D085_REJECTED_PASSES.map((r) => r.path),
);

/*
  The named constants readers and tests already use. They are LOOKUPS now, not
  second copies: no literal here can disagree with the record.
*/
export const D085_REJECTED_FIRST_PASS = rejectedPassFor(1);
export const D085_REJECTED_R2 = rejectedPassFor(2);
export const D085_REJECTED_R3 = rejectedPassFor(3);
export const D085_REJECTED_R4 = rejectedPassFor(4);
export const D085_REJECTED_R5 = rejectedPassFor(5);
export const D085_REJECTED_R6 = rejectedPassFor(6);
export const D085_REJECTED_R7 = rejectedPassFor(7);
export const D085_REJECTED_R8 = rejectedPassFor(8);
export const D085_REJECTED_R9 = rejectedPassFor(9);
export const D085_REJECTED_R10 = rejectedPassFor(10);
export const D085_REJECTED_R11 = rejectedPassFor(11);
export const D085_REJECTED_R12 = rejectedPassFor(12);
export const D085_REJECTED_R13 = rejectedPassFor(13);
export const D085_REJECTED_R14 = rejectedPassFor(14);
export const D085_REJECTED_R15 = rejectedPassFor(15);

const D083_PATH = "docs/audits/generated/d083-meta-budget-fact-observation-2026-09-01.json";
const D084_PATH = "docs/audits/generated/d084-commercial-target-evidence-2026-09-01.r6.json";

/** The accepted predecessor pins. A drift here fails the run. */
export const D085_ACCEPTED_PINS = {
  d083: "0c437aed77ca47148c7af27b59e850a32561d9dc6e8d934e507de7491cf5e747",
  d084File: "517780847ea93128d16406e75751e203034f7990fa5fbe34550d3f5c9f8c5b23",
  d084Artifact: "9274bd6c57c5c00688eb36181458538643ef8daf571b296361ea7b976b1fc2fd",
} as const;

export const D085_DIRECTIONS: readonly BudgetDirection[] = ["increase", "decrease"];
/** Fixed evaluation instant: the replay owns no wall clock. */
export const D085_EVALUATED_AT = "2026-09-01T00:00:00.000Z" as const;
/** The canonical profile actions each direction consults. */
export const DIRECTION_TO_ACTION = { increase: "scale", decrease: "cut" } as const;

type Row = Record<string, unknown>;

function sha(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}
function readPinned(path: string): { bytes: Buffer; sha256: string; json: Row } {
  // Canonical root, never cwd — the last cwd-relative read in this module.
  const bytes = d085TrustedReader(path);
  return { bytes, sha256: sha(bytes), json: JSON.parse(bytes.toString("utf8")) as Row };
}

export interface BindingRow {
  business: string;
  businessId: string;
  providerAccountId: string;
  accountSelected: boolean;
  currency: string | null;
  candidateObservations: number;
  candidateDistinctEntities: number;
}

export interface D085Snapshot {
  contract: typeof D085_CONTRACT_ID;
  provenance: {
    operatingClass: "prepare_read_only";
    automation: "off";
    maximumReachableAuthority: "validated_only";
    databaseAccess: "none";
    queriesExecuted: 0;
    providerWritesAttempted: 0;
    /** LOCAL app-route probes. Not provider contact. */
    localRouteProbesAttempted: number;
    /** Actual Meta provider contacts. Zero unless a request reached Meta. */
    providerContactsAttempted: number;
    /** Post-write read-backs. Zero while no write occurs. */
    readbackAttempts: number;
    wallClockFields: string;
    note: string;
  };
  sourceManifest: Array<{ key: string; path: string; expectedSha256: string; observedSha256: string; matches: boolean }>;
  predecessorPins: typeof D085_ACCEPTED_PINS & { d083Observed: string; d084FileObserved: string; d084ArtifactObserved: string };
  bindings: BindingRow[];
  /** D083's own readiness funnel, carried verbatim as the upstream population. */
  upstreamFunnel: Array<{ stage: string; survivors: number; eliminated: number; gate: string | null }>;
  upstreamDenominators: Row;
  /** D084's canonical-profile availability, carried verbatim. */
  canonicalProfileAvailability: Row[];
  fleet: Row;
  policyFingerprint: string;
}

export interface DryRunCell {
  business: string;
  businessId: string;
  providerAccountId: string;
  accountSelected: boolean;
  direction: BudgetDirection;
  canonicalAction: "scale" | "cut";
  /** Evaluations contributed by this cell = the binding's unique observations. */
  candidateEntityOriginEvaluations: number;
  status: "blocked" | "would_write_available";
  blockers: DryRunBlocker[];
  blockerDetail: Array<{ code: DryRunBlocker; why: string }>;
  wouldWriteAvailable: boolean;
  preflightOutcome: PreflightAttemptOutcome["status"] | "rejected";
  readbackClassification: "not_attempted";
  inputFingerprint: string;
  cellHash: string;
}

export interface D085Analysis {
  contractVersion: typeof D085_CONTRACT_ID;
  policyFingerprint: string;
  cells: DryRunCell[];
  /** The D085 stage funnel, over binding-direction cells. */
  funnel: Array<{ stage: string; survivors: number; eliminated: number; gate: string | null }>;
  blockerCensus: Array<{ code: DryRunBlocker; cells: number; entityOriginDirectionEvaluations: number }>;
  perBusiness: Array<{
    business: string; businessId: string; cells: number; blockedCells: number;
    wouldWriteCells: number; candidateEntityOriginEvaluations: number; blockers: DryRunBlocker[];
  }>;
  perAccount: Array<{
    providerAccountId: string; business: string; accountSelected: boolean;
    cells: number; blockedCells: number; wouldWriteCells: number; candidateEntityOriginEvaluations: number;
  }>;
  perDirection: Array<{ direction: BudgetDirection; canonicalAction: string; cells: number; blockedCells: number; wouldWriteCells: number }>;
  writeSafetyCensus: Array<{ step: WriteSafetyStep; satisfied: number; missing: number; notApplicable: number }>;
  providerPreflight: {
    localRouteProbes: { attempted: number; succeeded: number; failed: number; methods: string[]; statuses: number[] };
    providerContacts: { attempted: number; succeeded: number; failed: number; notAttempted: number };
    readbackAttempts: { attempted: number; classification: "not_attempted" };
    perBinding: Array<{ business: string; providerAccountId: string; outcome: string; why: string }>;
    semantics: string;
    note: string;
  };
  readback: {
    classification: "not_attempted";
    everyCellNotAttempted: boolean;
    why: string;
  };
  exposure: {
    basis: "nominal_proposed_only";
    unit: "raw_provider_minor_units";
    spendMoved: null; revenueMoved: null; roasLift: null; profitLift: null; optimalPercent: null;
    proposedExposureByAccount: Array<{ providerAccountId: string; currency: string | null; proposedMinorUnits: number | null; why: string }>;
    note: string;
  };
  reconciliation: {
    bindings: number; directions: number; expectedCells: number; observedCells: number;
    cellsBalanced: boolean;
    blockedPlusWouldWriteEqualsCells: boolean;
    /** Unique binding-level entity-origin observations (NOT multiplied by direction). */
    uniqueEntityOriginObservations: number;
    uniqueEntityOriginObservationsFromBindings: number;
    uniqueObservationsBalanced: boolean;
    /** One evaluation per (entity-origin observation x direction). */
    entityOriginDirectionEvaluations: number;
    entityOriginDirectionEvaluationsFromBindings: number;
    evaluationsBalanced: boolean;
    denominatorSemantics: string;
  };
  limits: string[];
  residualBlockers: Array<{ blocker: string; evidence: string; consequence: string; closes: string }>;
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

export function assembleSnapshot(providerReads: ProviderReadLedger = emptyProviderLedger()): D085Snapshot {
  const pinned = checkPinnedSources(d085TrustedReader);
  const d083 = readPinned(D083_PATH);
  const d084 = readPinned(D084_PATH);

  if (d083.sha256 !== D085_ACCEPTED_PINS.d083) {
    throw new Error(`D083 drifted: expected ${D085_ACCEPTED_PINS.d083}, observed ${d083.sha256}`);
  }
  if (d084.sha256 !== D085_ACCEPTED_PINS.d084File) {
    throw new Error(`D084 r6 drifted: expected ${D085_ACCEPTED_PINS.d084File}, observed ${d084.sha256}`);
  }
  const d084Artifact = String(d084.json.artifactHash ?? "");
  if (d084Artifact !== D085_ACCEPTED_PINS.d084Artifact) {
    throw new Error(`D084 r6 artifactHash drifted: observed ${d084Artifact}`);
  }

  const proposalImpact = (d083.json.proposalImpact ?? {}) as Row;
  const coverage = (d083.json.coverage ?? {}) as Row;
  const perBinding = (coverage.perBinding ?? []) as Row[];
  const analysis084 = (d084.json.analysis ?? {}) as Row;

  const bindings: BindingRow[] = perBinding.map((b) => ({
    business: String(b.business),
    businessId: String(b.businessId),
    providerAccountId: String(b.providerAccountId),
    accountSelected: b.accountSelected === true,
    currency: Array.isArray(b.currencies) && b.currencies.length === 1 ? String(b.currencies[0]) : null,
    candidateObservations: Number(b.candidateObservations ?? 0),
    candidateDistinctEntities: Number(b.candidateDistinctEntities ?? 0),
  }));

  return {
    contract: D085_CONTRACT_ID,
    provenance: {
      operatingClass: "prepare_read_only",
      automation: "off",
      maximumReachableAuthority: "validated_only",
      databaseAccess: "none",
      queriesExecuted: 0,
      providerWritesAttempted: 0,
      localRouteProbesAttempted: providerReads.routeProbesAttempted,
      providerContactsAttempted: providerReads.providerContactsAttempted,
      readbackAttempts: 0,
      wallClockFields: "none — the artifact is a pure function of the pinned bytes and the recorded provider-read ledger",
      note:
        "D085 assembles a dry run only. It adds no provider endpoint, no dispatch verb and no persistence. The strongest state reachable is validated_only.",
    },
    sourceManifest: pinned.map((p: PinnedSourceCheck) => ({
      key: p.key, path: p.path, expectedSha256: p.expectedSha256,
      observedSha256: p.observedSha256, matches: p.matches,
    })),
    predecessorPins: {
      ...D085_ACCEPTED_PINS,
      d083Observed: d083.sha256,
      d084FileObserved: d084.sha256,
      d084ArtifactObserved: d084Artifact,
    },
    bindings,
    upstreamFunnel: ((proposalImpact.canonicalIntentReadinessFunnel ?? []) as Row[]).map((s) => ({
      stage: String(s.stage), survivors: Number(s.survivors ?? 0),
      eliminated: Number(s.eliminated ?? 0), gate: s.gate === null ? null : String(s.gate),
    })),
    upstreamDenominators: (proposalImpact.denominators ?? {}) as Row,
    canonicalProfileAvailability: (analysis084.canonicalProfileAvailability ?? []) as Row[],
    fleet: (analysis084.fleet ?? {}) as Row,
    policyFingerprint: dryRunPolicyFingerprint(),
  };
}

// ---------------------------------------------------------------------------
// The provider-read ledger — recorded, never inferred
// ---------------------------------------------------------------------------

/**
 * Three counters, deliberately separate.
 *
 * The first pass published `providerReadsAttempted: 3` while the same evidence
 * proved Meta contact was zero: those three were LOCAL `/api/meta/adsets`
 * route probes that short-circuited on warehouse readiness before any provider
 * call. A local probe is not a provider read, and neither is a post-write
 * read-back.
 */
export interface ProviderReadLedger {
  routeProbesAttempted: number;
  routeProbesSucceeded: number;
  routeProbesFailed: number;
  routeProbeMethods: string[];
  routeProbeStatuses: number[];
  providerContactsAttempted: number;
  providerContactsSucceeded: number;
  providerContactsFailed: number;
  perBinding: Array<{ business: string; providerAccountId: string; outcome: PreflightAttemptOutcome; why: string }>;
  note: string;
}

/**
 * The ACTUAL bounded provider-preflight probe, recorded from the QA interval.
 *
 * Three GETs were issued to `/api/meta/adsets` — the one production route that
 * reaches a live ad-set read with `recordRawSnapshots: false`, i.e. the only
 * write-free path that requests the full preflight projection
 * (`daily_budget, lifetime_budget, effective_status, optimization_goal,
 * campaign_id`). All three returned HTTP 200 with `evidenceSource: "unknown"`
 * and zero rows: the route short-circuits on warehouse-readiness gates
 * *before* the live fallback, so the provider was never actually contacted and
 * no preflight projection could be obtained.
 *
 * That is recorded as `not_attempted` AT THE PROVIDER LAYER — not as a failure
 * and certainly not as readability — and it is itself a D085 readiness
 * finding: the write-free preflight read the future ceremony depends on exists
 * in code but is unreachable behind those gates.
 */
export const D085_PROVIDER_READ_PROBE = {
  routeProbesIssued: 3,
  routeProbeMethod: "GET",
  routeProbeStatuses: [200, 200, 200],
  route: "/api/meta/adsets",
  providerContactProven: false,
  projectionsObtained: 0,
  mutatingRequests: 0,
  why:
    "all three GETs returned evidenceSource=unknown with zero rows; the route resolved a warehouse-readiness branch and never took the live-provider fallback, so no provider preflight projection exists",
} as const;

export function recordedProviderLedger(bindings: readonly BindingRow[]): ProviderReadLedger {
  return {
    routeProbesAttempted: D085_PROVIDER_READ_PROBE.routeProbesIssued,
    routeProbesSucceeded: D085_PROVIDER_READ_PROBE.routeProbeStatuses.filter((x) => x === 200).length,
    routeProbesFailed: D085_PROVIDER_READ_PROBE.routeProbeStatuses.filter((x) => x !== 200).length,
    routeProbeMethods: [D085_PROVIDER_READ_PROBE.routeProbeMethod],
    routeProbeStatuses: [...D085_PROVIDER_READ_PROBE.routeProbeStatuses],
    // ZERO. The route never took the live-provider branch.
    providerContactsAttempted: 0,
    providerContactsSucceeded: 0,
    providerContactsFailed: 0,
    perBinding: bindings.map((b) => ({
      business: b.business,
      providerAccountId: b.providerAccountId,
      outcome: {
        status: "not_attempted" as const,
        why: D085_PROVIDER_READ_PROBE.why,
      },
      why:
        b.providerAccountId === "act_1087566732415606"
          ? `three bounded GET probes were issued for this binding; ${D085_PROVIDER_READ_PROBE.why}`
          : "no bounded GET probe was issued for this binding",
    })),
    note:
      `${D085_PROVIDER_READ_PROBE.routeProbesIssued} bounded LOCAL route GET probes to ${D085_PROVIDER_READ_PROBE.route} (all HTTP 200, zero mutating requests). Meta provider contact was ZERO: the route resolved a warehouse-readiness branch before the live fallback. A local route probe is not a provider read.`,
  };
}

export function emptyProviderLedger(): ProviderReadLedger {
  return {
    routeProbesAttempted: 0, routeProbesSucceeded: 0, routeProbesFailed: 0,
    routeProbeMethods: [], routeProbeStatuses: [],
    providerContactsAttempted: 0, providerContactsSucceeded: 0, providerContactsFailed: 0,
    perBinding: [],
    note:
      "no local route probe and no provider contact were attempted; every binding therefore reports not_attempted and no preflight readability is claimed",
  };
}

// ---------------------------------------------------------------------------
// Replay — a pure function of the snapshot
// ---------------------------------------------------------------------------

/**
 * Build the dry-run input for one binding and direction from pinned evidence.
 *
 * Nothing is invented. Where the pinned artifacts do not retain a fact, the
 * input says so and the contract raises the corresponding blocker.
 */
function inputFor(
  snapshot: D085Snapshot,
  binding: BindingRow,
  direction: BudgetDirection,
  ledger: ProviderReadLedger,
): DryRunInput {
  const action = DIRECTION_TO_ACTION[direction];
  const availability = snapshot.canonicalProfileAvailability.find(
    (a) => String(a.businessId) === binding.businessId,
  );
  const byAction = ((availability?.byAction ?? []) as Row[]).find((x) => String(x.action) === action);

  // D083 stage 6: the currency exponent was never captured for ANY survivor,
  // so `unitConfidence` is `unknown` for every binding. That is a retained
  // fact, not an assumption.
  const exponentCaptured = snapshot.upstreamFunnel.some(
    (s) => s.gate === "currency_exponent_not_captured" && s.survivors > 0,
  );

  const read = ledger.perBinding.find(
    (r) => r.providerAccountId === binding.providerAccountId,
  );
  const attempt: PreflightAttemptOutcome = read?.outcome ?? {
    status: "not_attempted",
    why: "no bounded provider GET was attempted for this binding",
  };

  // The write-safety ceremony, as the pinned evidence actually supports it.
  const writeSafety: DryRunInput["writeSafety"] = {};
  for (const step of WRITE_SAFETY_STEPS) writeSafety[step] = "missing";
  writeSafety.exact_business_access = "satisfied";
  writeSafety.exact_physical_provider_account = "satisfied";
  writeSafety.exact_target_identity = binding.candidateDistinctEntities > 0 ? "satisfied" : "missing";
  writeSafety.explicit_action_origin = "satisfied";

  return {
    contractVersion: META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
    decision: { id: null, hash: null, version: null, decidedAt: null, maxAgeSeconds: 86_400 },
    scope: {
      businessId: binding.businessId,
      business: binding.business,
      providerAccountId: binding.providerAccountId,
      // No single concrete entity is selected by a fleet replay: the funnel is
      // over a population, so the entity slot is honestly empty.
      entityGrain: null,
      entityId: null,
      parentCampaignId: null,
      accountIsWriteScope: binding.accountSelected,
      accountSelectionWhy: binding.accountSelected
        ? "selected serving account for this business"
        : "deselected account — read-only, never write scope",
    },
    direction,
    percent: null,
    accountCurrency: binding.currency,
    currencyExponent: exponentCaptured ? 2 : null,
    currencyRegistryVersion: String((snapshot.upstreamDenominators as Row).registry ?? "iso4217.minor-units.2026-09-01"),
    unitConfidence: exponentCaptured ? "exact" : "unknown",
    role: {
      role: null, source: null, resolverVersion: null, confidence: null, asOf: null,
      accountScoped: true,
      businessId: binding.businessId, providerAccountId: binding.providerAccountId,
      resolved: false,
      why: "D081 proved automatic role authority has no retained qualifying rows; unresolved stays unresolved",
    },
    budgetFact: {
      contractVersion: "meta.budget-fact.v4",
      available: false,
      currentMinorUnits: null,
      budgetField: null,
      ownerMode: "unknown",
      scheduleStart: null,
      scheduleEnd: null,
      observedAt: null,
      capturedAt: null,
      lineage: "D083 canonical contract defined; its seven additive columns are not applied in production and no admitted sync has accrued schedule/exponent/API provenance",
      availabilityWhy:
        "D083's readiness funnel ends at 0 intent-ready: every one of the 32,859 pairs that survived scope, hierarchy, ownership and schedule was eliminated on currency_exponent_not_captured",
    },
    commercial: {
      profileContractVersion: byAction ? String(byAction.expectedContract ?? "") || null : null,
      businessId: binding.businessId,
      providerAccountId: binding.providerAccountId,
      sourceStatus: byAction ? (String(byAction.status) === "not_determinable" ? "output_not_retained" : String(byAction.status)) : "unknown",
      selectedAction: action,
      eligible: byAction && byAction.eligible !== null ? Boolean(byAction.eligible) : null,
      code: byAction && byAction.code !== null ? String(byAction.code) : null,
      reason: byAction && byAction.reason !== null ? String(byAction.reason) : null,
      blockerCodes: byAction?.reasonCode ? [String(byAction.reasonCode)] : [],
      evidenceFloorsClear: null,
      changeSafetyClear: null,
    },
    safety: {
      // The pinned artifacts retain NO live kill-switch, admission, cap,
      // cooldown or conflict state. The first pass wrote `false` for all five
      // and called that "not inflating the blocker list" — but unknown is not
      // clear, and a control nobody read cannot clear a proposal. Each stays
      // `unknown` and blocks as unverified.
      killSwitch: unknownSafetyFlag("no pinned artifact retains the server-side kill-switch state"),
      admission: unknownSafetyFlag("no pinned artifact retains decision-pipeline admission state"),
      cap: unknownSafetyFlag("no pinned artifact retains per-day change history, so the cap is unverified"),
      cooldown: unknownSafetyFlag("no pinned artifact retains per-day change history, so the cooldown is unverified"),
      conflict: unknownSafetyFlag("no pinned artifact retains conflict-lock state"),
    },
    capability: PROVIDER_CAPABILITY_TODAY,
    rawIntent: null,
    knownBindings: [],
    intent: null,
    intentRejections: ["current_value_missing", "currency_exponent_unknown"],
    casBaseline: null,
    preflight: comparePreflight(
      {
        providerAccountId: binding.providerAccountId, entityGrain: "adset", entityId: "",
        parentCampaignId: null, budgetField: "daily_budget", budgetMinorUnits: null,
        ownerMode: "unknown", effectiveStatus: null, scheduleStart: null, scheduleEnd: null,
        optimizationGoal: null,
      },
      attempt,
      // A fixed evaluation clock keeps the replay a pure function of the
      // pinned bytes; the origin day is the only clock this package owns.
      { evaluatedAt: `${D085_EVALUATED_AT}` },
    ),
    preflightEvidence: {
      // The RAW attempt, so the builder re-derives rather than trusts.
      rawAttempt: attempt,
      evaluatedAt: D085_EVALUATED_AT,
      baselineFingerprint: null,
    },
    writeSafety,
    originDate: "2026-09-01",
    knowledgeAsOf: "2026-09-01T00:00:00.000Z",
  };
}

export function replay(snapshot: D085Snapshot, ledger: ProviderReadLedger): D085Analysis {
  const cells: DryRunCell[] = [];
  for (const binding of snapshot.bindings) {
    for (const direction of D085_DIRECTIONS) {
      const input = inputFor(snapshot, binding, direction, ledger);
      const run = buildBudgetProposalDryRun(input);
      const cell: DryRunCell = {
        business: binding.business,
        businessId: binding.businessId,
        providerAccountId: binding.providerAccountId,
        accountSelected: binding.accountSelected,
        direction,
        canonicalAction: DIRECTION_TO_ACTION[direction],
        candidateEntityOriginEvaluations: binding.candidateObservations,
        status: run.status,
        blockers: run.blockers,
        blockerDetail: run.blockerDetail,
        wouldWriteAvailable: run.wouldWriteRequest !== null,
        preflightOutcome: input.preflight?.outcome ?? "not_attempted",
        readbackClassification: "not_attempted",
        inputFingerprint: run.inputFingerprint,
        cellHash: canonicalDigest({
          business: binding.businessId, account: binding.providerAccountId, direction,
          status: run.status, blockers: run.blockers,
        }),
      };
      cells.push(cell);
    }
  }
  cells.sort((a, b) =>
    `${a.businessId}|${a.providerAccountId}|${a.direction}`.localeCompare(
      `${b.businessId}|${b.providerAccountId}|${b.direction}`));

  // --- funnel over binding-direction cells ---
  const total = cells.length;
  const writeScope = cells.filter((c) => c.accountSelected);
  const withConcreteEntity = writeScope.filter((c) => !c.blockers.includes("no_concrete_entity_selected"));
  const withFact = withConcreteEntity.filter((c) => !c.blockers.includes("budget_fact_unavailable"));
  const withExponent = withFact.filter((c) => !c.blockers.includes("currency_exponent_unknown"));
  const withAuthority = withExponent.filter((c) => !c.blockers.includes("commercial_profile_unavailable"));
  const withPreflight = withAuthority.filter((c) => !c.blockers.includes("provider_preflight_not_readable"));
  const wouldWrite = cells.filter((c) => c.wouldWriteAvailable);

  const funnel: D085Analysis["funnel"] = [
    { stage: "0 - binding x direction cells", survivors: total, eliminated: 0, gate: null },
    { stage: "1 - account is write scope", survivors: writeScope.length, eliminated: total - writeScope.length, gate: "account_not_write_scope" },
    { stage: "2 - a concrete entity is selected", survivors: withConcreteEntity.length, eliminated: writeScope.length - withConcreteEntity.length, gate: "no_concrete_entity_selected" },
    { stage: "3 - canonical budget fact available", survivors: withFact.length, eliminated: withConcreteEntity.length - withFact.length, gate: "budget_fact_unavailable" },
    { stage: "4 - currency exponent captured", survivors: withExponent.length, eliminated: withFact.length - withExponent.length, gate: "currency_exponent_unknown" },
    { stage: "5 - commercial authority resolved", survivors: withAuthority.length, eliminated: withExponent.length - withAuthority.length, gate: "commercial_profile_unavailable" },
    { stage: "6 - provider preflight readable", survivors: withPreflight.length, eliminated: withAuthority.length - withPreflight.length, gate: "provider_preflight_not_readable" },
    { stage: "would-write available", survivors: wouldWrite.length, eliminated: withPreflight.length - wouldWrite.length, gate: "no_provider_write_path_exists" },
  ];

  const blockerCensus = DRY_RUN_BLOCKERS.map((code) => {
    const hit = cells.filter((c) => c.blockers.includes(code));
    return {
      code,
      cells: hit.length,
      entityOriginDirectionEvaluations: hit.reduce((s, c) => s + c.candidateEntityOriginEvaluations, 0),
    };
  }).filter((r) => r.cells > 0);

  const businessIds = Array.from(new Set(cells.map((c) => c.businessId))).sort();
  const perBusiness = businessIds.map((id) => {
    const mine = cells.filter((c) => c.businessId === id);
    return {
      business: mine[0]!.business, businessId: id, cells: mine.length,
      blockedCells: mine.filter((c) => c.status === "blocked").length,
      wouldWriteCells: mine.filter((c) => c.wouldWriteAvailable).length,
      candidateEntityOriginEvaluations: mine.reduce((s, c) => s + c.candidateEntityOriginEvaluations, 0),
      blockers: DRY_RUN_BLOCKERS.filter((b) => mine.some((c) => c.blockers.includes(b))),
    };
  });

  const accountIds = Array.from(new Set(cells.map((c) => c.providerAccountId))).sort();
  const perAccount = accountIds.map((id) => {
    const mine = cells.filter((c) => c.providerAccountId === id);
    return {
      providerAccountId: id, business: mine[0]!.business, accountSelected: mine[0]!.accountSelected,
      cells: mine.length,
      blockedCells: mine.filter((c) => c.status === "blocked").length,
      wouldWriteCells: mine.filter((c) => c.wouldWriteAvailable).length,
      candidateEntityOriginEvaluations: mine.reduce((s, c) => s + c.candidateEntityOriginEvaluations, 0),
    };
  });

  const perDirection = D085_DIRECTIONS.map((d) => {
    const mine = cells.filter((c) => c.direction === d);
    return {
      direction: d, canonicalAction: DIRECTION_TO_ACTION[d], cells: mine.length,
      blockedCells: mine.filter((c) => c.status === "blocked").length,
      wouldWriteCells: mine.filter((c) => c.wouldWriteAvailable).length,
    };
  });

  const writeSafetyCensus = writeSafetyCensusOf(snapshot, ledger);

  // TWO denominators, never one name. r2 summed the same population across two
  // directions and called the product "pairs".
  const uniqueObservationsFromBindings = snapshot.bindings.reduce((s, b) => s + b.candidateObservations, 0);
  const evaluationsFromCells = cells.reduce((s, c) => s + c.candidateEntityOriginEvaluations, 0);
  const evaluationsFromBindings = uniqueObservationsFromBindings * D085_DIRECTIONS.length;
  const uniqueObservationsFromCells = evaluationsFromCells / D085_DIRECTIONS.length;

  return {
    contractVersion: D085_CONTRACT_ID,
    policyFingerprint: snapshot.policyFingerprint,
    cells,
    funnel,
    blockerCensus,
    perBusiness,
    perAccount,
    perDirection,
    writeSafetyCensus,
    providerPreflight: {
      localRouteProbes: {
        attempted: ledger.routeProbesAttempted,
        succeeded: ledger.routeProbesSucceeded,
        failed: ledger.routeProbesFailed,
        methods: [...ledger.routeProbeMethods],
        statuses: [...ledger.routeProbeStatuses],
      },
      providerContacts: {
        attempted: ledger.providerContactsAttempted,
        succeeded: ledger.providerContactsSucceeded,
        failed: ledger.providerContactsFailed,
        notAttempted: snapshot.bindings.length - ledger.perBinding.filter((r) => r.outcome.status === "succeeded").length,
      },
      readbackAttempts: { attempted: 0, classification: "not_attempted" },
      perBinding: ledger.perBinding.map((r) => ({
        business: r.business, providerAccountId: r.providerAccountId,
        outcome: r.outcome.status, why: r.why,
      })),
      semantics:
        "a LOCAL route probe is an app GET and is never provider contact; a provider contact is a request that actually reached Meta; a read-back attempt exists only after a write. All three are counted separately and none substitutes for another.",
      note: ledger.note,
    },
    readback: {
      classification: "not_attempted",
      everyCellNotAttempted: cells.every((c) => c.readbackClassification === "not_attempted"),
      why:
        "D085 dispatches no provider mutation, so no post-write read-back exists. A preflight GET or an unchanged no-write GET is preflight evidence and is never relabelled as write success.",
    },
    exposure: {
      basis: "nominal_proposed_only",
      unit: "raw_provider_minor_units",
      spendMoved: null, revenueMoved: null, roasLift: null, profitLift: null, optimalPercent: null,
      proposedExposureByAccount: snapshot.bindings.map((b) => ({
        providerAccountId: b.providerAccountId,
        currency: b.currency,
        proposedMinorUnits: null,
        why: "no proposal reached a would-write request, and the minor-unit exponent was never captured, so no authoritative raw exposure may be published",
      })),
      note:
        "No proposal was executed, queued, served or approved. No causal ROAS, revenue or profit lift and no optimal percent is supportable: D084 proves 14-23 possible economic actions with no randomised assignment.",
    },
    reconciliation: {
      bindings: snapshot.bindings.length,
      directions: D085_DIRECTIONS.length,
      expectedCells: snapshot.bindings.length * D085_DIRECTIONS.length,
      observedCells: cells.length,
      cellsBalanced: cells.length === snapshot.bindings.length * D085_DIRECTIONS.length,
      blockedPlusWouldWriteEqualsCells:
        cells.filter((c) => c.status === "blocked").length + cells.filter((c) => c.wouldWriteAvailable).length === cells.length,
      uniqueEntityOriginObservations: uniqueObservationsFromCells,
      uniqueEntityOriginObservationsFromBindings: uniqueObservationsFromBindings,
      uniqueObservationsBalanced: uniqueObservationsFromCells === uniqueObservationsFromBindings,
      entityOriginDirectionEvaluations: evaluationsFromCells,
      entityOriginDirectionEvaluationsFromBindings: evaluationsFromBindings,
      evaluationsBalanced: evaluationsFromCells === evaluationsFromBindings,
      denominatorSemantics:
        "uniqueEntityOriginObservations counts each binding-level entity-origin observation ONCE; entityOriginDirectionEvaluations counts one evaluation per observation per direction. The second is the first multiplied by the direction count and is never a unique-pair denominator.",
    },
    limits: [...D085_CANONICAL_LIMITS],
    residualBlockers: [
      {
        blocker: "no_provider_write_path_exists",
        evidence: "MutationAction is pause|resume|bid|duplicate and MUTATION_ENDPOINTS has no budget action at any grain",
        consequence: "no budget proposal can be dispatched from this codebase, whatever its evidence",
        closes: "a budget endpoint, its dispatch verb, and the full write-safety ceremony are added under a separate approved slice",
      },
      {
        blocker: "currency_exponent_not_captured",
        evidence: "D083 stage 6 eliminates all 32,859 surviving entity-origin pairs",
        consequence: "no authoritative raw provider-unit value or delta may be published for any binding",
        closes: "D083's additive exponent capture is applied and an admitted sync accrues it",
      },
      {
        blocker: "canonical_profile_output_not_retained",
        evidence: "all 18 business-action pairs are not_determinable in D084 r6",
        consequence: "no commercial eligibility may be stated in either direction",
        closes: "a byte-inspectable production resolver result over fully frozen inputs is captured",
      },
      {
        blocker: "automatic_role_authority_absent",
        evidence: "D081 found no retained qualifying rows for automatic role authority",
        consequence: "role context stays unresolved and no role-scoped proposal may be raised",
        closes: "qualifying role-provenance rows accrue under the existing automatic resolver",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Verify — independent of the assembler
// ---------------------------------------------------------------------------

export interface VerifyResult { ok: boolean; failures: string[]; checked: string[] }

/**
 * The COMPLETE rejected lineage, DERIVED from the canonical records.
 *
 * r9 published a list that stopped at v5 while the contract was already v9.
 * r15 published a list whose v2 digest matched no file. Both were the same
 * defect: a second copy of a fact. There is no second copy now — this is a
 * projection of `D085_REJECTED_PASSES`, so the range and every digest follow
 * the record by construction.
 */
export const D085_REJECTED_LINEAGE: ReadonlyArray<{ contract: string; file: string }> = Object.freeze(
  D085_REJECTED_PASSES.map((r) => Object.freeze({ contract: r.contract, file: r.fileSha256 })),
);

/**
 * The COMPLETE receipt migration lineage, taken DIRECTLY from the runtime
 * source. Earlier versions are unverifiable.
 *
 * r15 retyped `meta.budget-preview-receipt.v1 … v11` here as string literals
 * beside the runtime's own derived list — a second place for the same fact to
 * go stale.
 */
export const D085_RECEIPT_LINEAGE: readonly string[] = META_BUDGET_PREVIEW_RECEIPT_REJECTED_VERSIONS;
/** Every receipt contract that has ever been issued, current one included. */
export const D085_RECEIPT_LINEAGE_ALL: readonly string[] = [
  ...D085_RECEIPT_LINEAGE, PREVIEW_CONTRACT_VERSION,
];

/**
 * How a provider-contact assertion is EVIDENCED.
 *
 * r9 derived the zero-contact claim from a hard-coded probe constant, then
 * re-derived it in the generator and the verifier from that same constant, and
 * called it independent proof. It is self-report. The class is now explicit,
 * and `recorded_by_local_process` is the honest default.
 */
export const PROVIDER_CONTACT_EVIDENCE_CLASSES = [
  "recorded_by_local_process",
  "independent_transport_sentinel",
] as const;

/** The exact top-level sections a D085 artifact publishes. Nothing else. */
export const D085_ARTIFACT_TOP_LEVEL_KEYS = [
  "contract", "snapshot", "analysis", "snapshotHash", "analysisHash",
  "rejectedLineage", "receiptLineage", "verificationGuarantee",
  "providerContactEvidence", "pointInTimePolicy", "artifactHash",
] as const;

/**
 * The write-safety census, DERIVED from the frozen snapshot and ledger.
 *
 * Exported so the verifier recomputes it rather than trusting the published
 * array. r10 checked only the envelope hash, so emptying the census and
 * re-sealing verified clean.
 */
export function writeSafetyCensusOf(
  snapshot: D085Snapshot,
  ledger: ReturnType<typeof recordedProviderLedger>,
): Array<{ step: WriteSafetyStep; satisfied: number; missing: number; notApplicable: number }> {
  return WRITE_SAFETY_STEPS.map((step) => {
    let satisfied = 0, missing = 0, notApplicable = 0;
    for (const binding of snapshot.bindings) {
      for (const direction of D085_DIRECTIONS) {
        const v = inputFor(snapshot, binding, direction, ledger).writeSafety[step];
        if (v === "satisfied") satisfied += 1;
        else if (v === "not_applicable") notApplicable += 1;
        else missing += 1;
      }
    }
    return { step, satisfied, missing, notApplicable };
  });
}

/** The canonical provider-contact evidence block, compared not merely shaped. */
export const D085_PROVIDER_CONTACT_EVIDENCE = {
  evidenceClass: "recorded_by_local_process" as const,
  assertion: "No Meta provider endpoint was contacted while producing this artifact.",
  basis: "The three attempted reads were local Next.js route probes that short-circuited on warehouse readiness before any provider call. The count is recorded by this process and re-derived from that same record by the generator and the verifier.",
  limitation: "This is a local recording, not independent evidence. A genuinely independent claim would require a fail-if-called transport sentinel installed at the outbound seam, observed by a party other than the code under test. No such sentinel is installed, so this assertion must be read as recorded-by-this-process.",
} as const;

/** The canonical deterministic limits text. */
export const D085_CANONICAL_LIMITS: readonly string[] = [
  "Every fact is read from a pinned artifact; D085 opened no database transaction and issued no provider write.",
  "The pinned artifacts do not retain live kill-switch, admission, cap, cooldown or conflict state. Those flags are recorded UNKNOWN, not false: unknown is not clear, so every replay cell carries the corresponding *_unverified blocker. The earlier wording here said they were recorded false 'so that no blocker is inflated', which contradicted the implementation and understated the published blocker set.",
  "A fleet replay selects no single concrete entity, so `no_concrete_entity_selected` is expected and correct for every cell; a per-entity dry run is the surface path, not the replay path.",
  "D083's seven additive budget-fact columns are not applied in production and no admitted sync has accrued schedule/exponent/API provenance. D085 does not apply that migration.",
];

export function canonicalRejectedLineage() {
  return D085_REJECTED_LINEAGE.map((r) => ({ contract: r.contract, fileSha256: r.file, status: "rejected" as const }));
}

export function canonicalReceiptLineage() {
  return {
    current: PREVIEW_CONTRACT_VERSION,
    rejected: D085_RECEIPT_LINEAGE_ALL.filter((v) => v !== PREVIEW_CONTRACT_VERSION),
    migration: "A receipt carrying any earlier contract identifier is reported UNVERIFIABLE. Stricter semantics are never applied retroactively to a receipt issued under an older identifier, and an older receipt is never silently reported false for the wrong reason.",
  };
}

/** A stable, non-leaking classification of a filesystem read failure. */
export function readFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z]{2,20}$/.test(code) ? code : "READ_FAILED";
}

/**
 * Rebuild the snapshot and analysis this build would produce, from the trusted
 * pinned local sources and the recorded local ledger.
 *
 * This is the verifier's independent expectation. It reads only canonically
 * resolved trusted paths and never a path supplied by the artifact.
 */
export function reconstructExpected(): { snapshot: D085Snapshot; analysis: D085Analysis } {
  // Exactly the generator's own two-pass shape: a probe snapshot to resolve
  // the recorded ledger, then the real snapshot and its replay.
  const probe = assembleSnapshot(emptyProviderLedger());
  const resolved = recordedProviderLedger(probe.bindings);
  const snapshot = assembleSnapshot(resolved);
  return { snapshot, analysis: replay(snapshot, resolved) };
}

/**
 * The first few concrete structural differences, as stable dotted paths.
 *
 * A digest mismatch says "something differs"; a reviewer needs to know WHAT.
 * Values are never interpolated — only paths and a type/length classification
 * — so an attacker-controlled string cannot reach the failure output.
 */
export function firstStructuralDifferences(
  expected: unknown, actual: unknown, path: string, out: string[] = [], limit = 8,
): string[] {
  if (out.length >= limit) return out;
  const kind = (v: unknown) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  if (kind(expected) !== kind(actual)) {
    out.push(`${path} is ${kind(actual)}, expected ${kind(expected)}`);
    return out;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      out.push(`${path} has ${actual.length} entries, expected ${expected.length}`);
      return out;
    }
    for (let i = 0; i < expected.length && out.length < limit; i += 1) {
      firstStructuralDifferences(expected[i], actual[i], `${path}[${i}]`, out, limit);
    }
    return out;
  }
  if (expected !== null && typeof expected === "object" && actual !== null && typeof actual === "object") {
    const e = Object.keys(expected as Record<string, unknown>).sort();
    const a = Object.keys(actual as Record<string, unknown>).sort();
    const extra = a.filter((k) => !e.includes(k));
    const missing = e.filter((k) => !a.includes(k));
    if (extra.length > 0) out.push(`${path} carries unrecognised keys {${extra.join(", ")}}`);
    if (missing.length > 0) out.push(`${path} is missing keys {${missing.join(", ")}}`);
    for (const k of e) {
      if (out.length >= limit) break;
      if (a.includes(k)) {
        firstStructuralDifferences(
          (expected as Record<string, unknown>)[k], (actual as Record<string, unknown>)[k], `${path}.${k}`, out, limit,
        );
      }
    }
    return out;
  }
  if (expected !== actual) out.push(`${path} differs from the reconstructed value`);
  return out;
}

/**
 * Write EVERY byte through an owned descriptor, or fail.
 *
 * `writeSync` is permitted to write fewer bytes than requested. r13 called it
 * once, ignored the return value, closed and renamed — so a short write
 * published a TRUNCATED artifact atomically. Atomic rename and complete
 * content are two different properties, and r13 conflated them.
 *
 * The loop advances by the RETURNED count. Zero progress, a negative result, a
 * count larger than what remains, or a throw are all failures: the caller
 * closes and unlinks only its own temp, and never renames an incomplete file.
 */
/**
 * Publish `payload` at `finalPath` by way of an EXCLUSIVELY created temp file.
 *
 * Split out of the assemble path so the ownership rule below can be exercised
 * — by `publisherSelfTest`, which chooses its own directory — rather than
 * merely asserted in a comment. r15 made it exercisable by EXPORTING it, which
 * handed every caller a destination of their choosing; see the note below.
 *
 * OWNERSHIP IS RECORDED ONLY AFTER A SUCCESSFUL EXCLUSIVE OPEN.
 *
 * r14's catch unconditionally unlinked the temp path — including when
 * `openSync` had FAILED before this process ever acquired it. On an EEXIST
 * collision it therefore deleted a file or symlink it did not own,
 * reintroducing exactly the harm the exclusive open was added to prevent.
 * Nothing is unlinked here unless this call created the path.
 */
/*
  PRIVATE. r15 EXPORTED this, so any caller could name a destination, name a
  temp path, pass a no-op `revalidate`, and overwrite an accessible file — a
  frozen D085 artifact included. `assertWritableArtifactPath` guards
  `runAssemble`'s closure, not an exported primitive. Making a guard
  exercisable must not hand out the capability it guards.
*/
function atomicPublish(args: {
  finalPath: string;
  tempPath: string;
  payload: Buffer;
  revalidate: () => void;
}): void {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow;
  let fd: number | null = null;
  let ownsTemp = false;
  try {
    fd = openSync(args.tempPath, flags, 0o644);
    ownsTemp = true;   // the exclusive open created this path; we own it
    writeAllBytes(fd, args.payload);
    closeSync(fd);
    fd = null;
    args.revalidate();
    renameSync(args.tempPath, args.finalPath);
  } catch (error) {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    // Clean up ONLY a temp this call actually created. If the exclusive open
    // never succeeded, there is nothing of ours to remove and we touch nothing.
    if (ownsTemp) { try { unlinkSync(args.tempPath); } catch { /* already gone */ } }
    throw error;
  }
}

/*
  INTERNAL. r15 exported this alongside `atomicPublish`, handing callers an
  injectable writer. Its complete loop coverage now runs through
  `publisherSelfTest`, which takes no arguments and chooses nothing.
*/
function writeAllBytes(
  fd: number,
  payload: Buffer,
  write: (fd: number, buf: Buffer, offset: number, length: number) => number = writeSync,
): void {
  let offset = 0;
  let guard = 0;
  while (offset < payload.length) {
    if (guard++ > payload.length + 1) {
      throw new Error(`write did not converge after ${guard} attempts at offset ${offset} of ${payload.length}`);
    }
    const remaining = payload.length - offset;
    const written = write(fd, payload, offset, remaining);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error(`write returned ${String(written)} at offset ${offset} of ${payload.length}; no progress`);
    }
    if (written > remaining) {
      throw new Error(`write reported ${written} bytes with only ${remaining} remaining`);
    }
    offset += written;
  }
  if (offset !== payload.length) {
    throw new Error(`wrote ${offset} of ${payload.length} bytes`);
  }
}

/**
 * The ownership and completeness proof for the private publisher, run through
 * an entrypoint that grants the caller NO authority.
 *
 * r14's `catch` unlinked a temp path a FAILED exclusive open had never
 * acquired. r15 made that reachable by exporting the publisher with a
 * caller-selected `finalPath`, `tempPath` and policy callback — trading a
 * comment for a write capability. This function takes no arguments, creates
 * and removes its own `mkdtemp` directory, and returns what it observed. There
 * is nothing here for a caller to point somewhere else.
 */
export interface PublisherSelfTestReport {
  readonly ok: boolean;
  readonly directory: string;
  readonly positiveControl: { published: boolean; bytesExact: boolean; tempRemoved: boolean };
  readonly collisionRegularFile: {
    openFailed: boolean; errorCode: string; ownedTemp: boolean;
    sentinelSurvived: boolean; sentinelBytesUnchanged: boolean;
    revalidateRan: boolean; finalPublished: boolean;
  };
  readonly collisionSymlink: {
    openFailed: boolean; ownedTemp: boolean; symlinkSurvived: boolean;
    targetBytesUnchanged: boolean; finalPublished: boolean;
  };
  readonly ownedTempCleanup: { threw: boolean; tempRemoved: boolean; finalPublished: boolean };
  readonly partialWrites: {
    singleShotExact: boolean; chunkedExact: boolean; shortFinalWriteExact: boolean;
    zeroProgressThrows: boolean; throwingWriterPropagates: boolean; negativeCountThrows: boolean;
  };
}

export function publisherSelfTest(): PublisherSelfTestReport {
  const dir = mkdtempSync(join(tmpdir(), "d085-publisher-selftest-"));
  const payload = Buffer.from("published bytes\n", "utf8");
  try {
    // --- positive control: a free temp path publishes and leaves no temp ----
    const finalA = join(dir, "published.json");
    const tempA = join(dir, "free.tmp");
    atomicPublish({ finalPath: finalA, tempPath: tempA, payload, revalidate: () => {} });
    const positiveControl = {
      published: existsSync(finalA),
      bytesExact: existsSync(finalA) && readFileSync(finalA).equals(payload),
      tempRemoved: !existsSync(tempA),
    };
    unlinkSync(finalA);

    // --- a COLLIDING regular file is not ours, and must be untouched -------
    const victim = join(dir, "victim.tmp");
    const sentinel = Buffer.from("PRE-EXISTING BYTES THAT ARE NOT OURS\n", "utf8");
    writeFileSync(victim, sentinel);
    let revalidateRan = false;
    let code = "";
    let openFailed = false;
    try {
      atomicPublish({
        finalPath: finalA, tempPath: victim, payload,
        revalidate: () => { revalidateRan = true; },
      });
    } catch (error) {
      openFailed = true;
      code = readFailureCode(error);
    }
    const collisionRegularFile = {
      openFailed,
      errorCode: code,
      /*
        Ownership as OBSERVED, not as claimed: had this call treated the path
        as its own it would have unlinked it, exactly as r14 did.
      */
      ownedTemp: !existsSync(victim),
      sentinelSurvived: existsSync(victim),
      sentinelBytesUnchanged: existsSync(victim) && readFileSync(victim).equals(sentinel),
      revalidateRan,
      finalPublished: existsSync(finalA),
    };

    // --- a colliding SYMLINK is neither followed nor removed ---------------
    const target = join(dir, "frozen-artifact.json");
    const frozenBytes = Buffer.from("FROZEN HISTORY\n", "utf8");
    writeFileSync(target, frozenBytes);
    const link = join(dir, "link.tmp");
    symlinkSync(target, link);
    let symlinkOpenFailed = false;
    try {
      atomicPublish({ finalPath: finalA, tempPath: link, payload, revalidate: () => {} });
    } catch { symlinkOpenFailed = true; }
    const collisionSymlink = {
      openFailed: symlinkOpenFailed,
      ownedTemp: !existsSync(link),
      symlinkSurvived: existsSync(link),
      targetBytesUnchanged: readFileSync(target).equals(frozenBytes),
      finalPublished: existsSync(finalA),
    };

    // --- a temp we DID create is removed when a later step fails ----------
    const mine = join(dir, "mine.tmp");
    let threw = false;
    try {
      atomicPublish({
        finalPath: finalA, tempPath: mine, payload,
        revalidate: () => { throw new Error("the target is frozen history"); },
      });
    } catch { threw = true; }
    const ownedTempCleanup = { threw, tempRemoved: !existsSync(mine), finalPublished: existsSync(finalA) };

    // --- the partial-write loop publishes every byte or nothing -----------
    let loopCase = 0;
    const loop = (bytes: Buffer, write: (fd: number, b: Buffer, o: number, l: number) => number): Buffer | string => {
      const path = join(dir, `loop-${loopCase++}.bin`);
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
      try {
        writeAllBytes(fd, bytes, write);
        closeSync(fd);
        return readFileSync(path);
      } catch (error) {
        try { closeSync(fd); } catch { /* already closed */ }
        return `THREW:${(error as Error).message}`;
      } finally {
        try { unlinkSync(path); } catch { /* already gone */ }
      }
    };
    const long = Buffer.from("abcdefghijklmnopqrstuvwxyz0123456789", "utf8");
    const singleShot = loop(long, (fd, b, o, l) => writeSync(fd, b, o, l));
    let chunkCall = 0;
    const chunked = loop(long, (fd, b, o, l) => writeSync(fd, b, o, Math.min(l, chunkCall++ === 0 ? 4 : 7)));
    const shortFinal = loop(long, (fd, b, o, l) => writeSync(fd, b, o, l > 3 ? l - 3 : l));
    const zeroProgress = loop(long, () => 0);
    const throwingWriter = loop(long, () => { throw new Error("EIO"); });
    const negativeCount = loop(long, () => -1);
    const partialWrites = {
      singleShotExact: Buffer.isBuffer(singleShot) && singleShot.equals(long),
      chunkedExact: Buffer.isBuffer(chunked) && chunked.equals(long),
      shortFinalWriteExact: Buffer.isBuffer(shortFinal) && shortFinal.equals(long),
      zeroProgressThrows: typeof zeroProgress === "string" && zeroProgress.includes("no progress"),
      throwingWriterPropagates: typeof throwingWriter === "string" && throwingWriter.includes("EIO"),
      negativeCountThrows: typeof negativeCount === "string" && negativeCount.includes("no progress"),
    };

    const ok =
      positiveControl.published && positiveControl.bytesExact && positiveControl.tempRemoved
      && collisionRegularFile.openFailed && collisionRegularFile.errorCode === "EEXIST"
      && !collisionRegularFile.ownedTemp && collisionRegularFile.sentinelSurvived
      && collisionRegularFile.sentinelBytesUnchanged && !collisionRegularFile.revalidateRan
      && !collisionRegularFile.finalPublished
      && collisionSymlink.openFailed && !collisionSymlink.ownedTemp && collisionSymlink.symlinkSurvived
      && collisionSymlink.targetBytesUnchanged && !collisionSymlink.finalPublished
      && ownedTempCleanup.threw && ownedTempCleanup.tempRemoved && !ownedTempCleanup.finalPublished
      && Object.values(partialWrites).every(Boolean);

    return { ok, directory: dir, positiveControl, collisionRegularFile, collisionSymlink, ownedTempCleanup, partialWrites };
  } finally {
    // The self-test owns this directory and nothing else.
    rmSync(dir, { recursive: true, force: true });
  }
}

export function verifyArtifact(
  artifact: Record<string, unknown> | unknown,
  readBytes: (repoRelativePath: string) => Buffer = d085TrustedReader,
): VerifyResult {
  const failures: string[] = [];
  const checked: string[] = [];
  const fail = (section: string, why: string) => failures.push(`${section}: ${why}`);

  /*
    TOTAL, AND OBSERVED ONCE.

    r10 destructured its argument directly, so `verifyArtifact(null)`, a root
    Proxy throwing on `get`, and `sourceManifest: null` each threw instead of
    returning a verification failure. A verifier that throws has not verified
    anything, and its caller cannot tell a malformed artifact from a crash.
  */
  const observation = safeSnapshot(artifact, "artifact");
  if (!observation.ok) {
    return {
      ok: false,
      failures: [`artifact: could not be safely observed (${renderProblems(observation.problems)})`],
      checked,
    };
  }
  const observed = observation.value;
  if (observed === null || typeof observed !== "object" || Array.isArray(observed)) {
    return { ok: false, failures: ["artifact: the artifact is not a map"], checked };
  }
  const doc = observed as Record<string, unknown>;

  // EXACT top-level schema: extras, omissions and wrong containers all fail.
  {
    const schemaProblems: SchemaProblem[] = [];
    exactMap(doc, "artifact", D085_ARTIFACT_TOP_LEVEL_KEYS, [], schemaProblems);
    if (schemaProblems.length > 0) {
      fail("topLevelSchema", renderProblems(schemaProblems));
    }
  }
  checked.push("topLevelSchema");

  const snapshot = doc.snapshot as D085Snapshot | undefined;
  const analysis = doc.analysis as D085Analysis | undefined;
  if (!snapshot || !analysis || typeof snapshot !== "object" || typeof analysis !== "object") {
    return { ok: false, failures: [...failures, "artifact: snapshot or analysis missing or malformed"], checked };
  }
  if (!Array.isArray(snapshot.sourceManifest)) {
    return { ok: false, failures: [...failures, `pinnedSources: sourceManifest is not an array`], checked };
  }

  /*
    THE WHOLE STRUCTURE, RECONSTRUCTED AND COMPARED — not dereferenced on trust.

    r11 enforced an exact schema at the TOP LEVEL and then walked into
    `snapshot.provenance.databaseAccess`, `analysis.cells[0].status`,
    `analysis.providerPreflight.localRouteProbes.statuses.length` and a dozen
    more nested paths as though they existed. Nineteen null-substitutions threw
    `TypeError`, and six coherently resealed extra keys verified clean.

    Rather than add nineteen guards and six key lists, the expected snapshot and
    analysis are REBUILT here from the trusted pinned local sources and the
    recorded local ledger, and the published structures are compared to them in
    full — every key, every value, every array position. A malformed nested
    container simply differs from the reconstruction; so does an extra key; so
    does a reordered array. One comparison replaces the whole class.

    Every file read below is contained: a read failure becomes a stable failure
    code, never a thrown Error, and trusted paths resolve canonically from the
    repository root rather than against the process cwd.
  */
  let reconstructed: { snapshot: D085Snapshot; analysis: D085Analysis } | null = null;
  try {
    reconstructed = reconstructExpected();
  } catch (error) {
    return {
      ok: false,
      failures: [...failures, `reconstruction: the trusted local sources could not be read (${readFailureCode(error)})`],
      checked,
    };
  }
  {
    const publishedSnapshot = canonicalDigest(snapshot as never);
    const expectedSnapshot = canonicalDigest(reconstructed.snapshot as never);
    if (publishedSnapshot !== expectedSnapshot) {
      fail("reconstruction", "the published snapshot is not byte-identical to the snapshot rebuilt from the trusted pinned sources and recorded ledger");
      for (const diff of firstStructuralDifferences(reconstructed.snapshot as never, snapshot as never, "snapshot")) {
        fail("reconstruction", diff);
      }
    }
    const publishedAnalysis = canonicalDigest(analysis as never);
    const expectedAnalysis = canonicalDigest(reconstructed.analysis as never);
    if (publishedAnalysis !== expectedAnalysis) {
      fail("reconstruction", "the published analysis is not byte-identical to the analysis rebuilt from the trusted pinned sources and recorded ledger");
      for (const diff of firstStructuralDifferences(reconstructed.analysis as never, analysis as never, "analysis")) {
        fail("reconstruction", diff);
      }
    }
  }
  checked.push("reconstruction");
  // Once the reconstruction disagrees, every downstream typed dereference is
  // unsafe. Stop here with a deterministic result rather than walking on.
  if (failures.length > 0) {
    return { ok: false, failures, checked };
  }

  if (doc.contract !== D085_CONTRACT_ID) fail("contract", `contract is ${String(doc.contract)}`);

  /*
    THE HASH CHAIN, RECOMPUTED — not read.

    r9's verifier never recomputed a single hash, so five independent
    mutations each returned ok:true with failures []: replacing the top-level
    artifactHash, downgrading snapshot.contract to v1, downgrading
    analysis.contractVersion to v1, emptying analysis.writeSafetyCensus, and
    removing the first sourceManifest entry. A verifier that reads a published
    hash and compares it to itself verifies nothing.
  */
  const recomputedSnapshotHash = canonicalDigest(snapshot);
  const recomputedAnalysisHash = canonicalDigest(analysis);
  if (doc.snapshotHash !== recomputedSnapshotHash) {
    fail("hashChain", `the published snapshotHash ${String(doc.snapshotHash)} does not reproduce from the snapshot (recomputed ${recomputedSnapshotHash})`);
  }
  if (doc.analysisHash !== recomputedAnalysisHash) {
    fail("hashChain", `the published analysisHash ${String(doc.analysisHash)} does not reproduce from the analysis (recomputed ${recomputedAnalysisHash})`);
  }
  {
    // The artifact hash covers everything EXCEPT itself, exactly as minted.
    const { artifactHash: published, ...bare } = doc as Record<string, unknown> & { artifactHash?: unknown };
    const recomputedArtifactHash = canonicalDigest(bare);
    if (published !== recomputedArtifactHash) {
      fail("hashChain", `the published artifactHash ${String(published)} does not reproduce from the artifact body (recomputed ${recomputedArtifactHash})`);
    }
  }
  checked.push("hashChain");

  // EXACT nested contract identifiers. A downgraded nested contract must not
  // pass because the top-level one is still current.
  if (snapshot.contract !== D085_CONTRACT_ID) {
    fail("nestedContracts", `snapshot.contract is ${String(snapshot.contract)}, not ${D085_CONTRACT_ID}`);
  }
  if (analysis.contractVersion !== D085_CONTRACT_ID) {
    fail("nestedContracts", `analysis.contractVersion is ${String(analysis.contractVersion)}, not ${D085_CONTRACT_ID}`);
  }
  checked.push("nestedContracts");

  // (rejected lineage is compared to its canonical constant above)

  /*
    CANONICAL EQUALITY, not "non-empty and contains a keyword".

    r10 accepted a verificationGuarantee replaced by minimally non-empty
    arbitrary prose, a rewritten pointInTimePolicy.ordering, rewritten
    providerContactEvidence sentences, and replaced analysis.limits. Prose the
    artifact publishes about its own guarantees is a CLAIM, and a claim is
    verified by comparing it to the canonical constant that produced it — not
    by checking that it is non-empty.
  */
  for (const [section, published, canonical] of [
    ["verificationGuarantee", doc.verificationGuarantee, RECEIPT_VERIFICATION_GUARANTEE],
    ["pointInTimePolicy", doc.pointInTimePolicy, PIT_POLICY],
    ["providerContactEvidence", doc.providerContactEvidence, D085_PROVIDER_CONTACT_EVIDENCE],
    ["receiptLineage", doc.receiptLineage, canonicalReceiptLineage()],
    ["rejectedLineage", doc.rejectedLineage, canonicalRejectedLineage()],
  ] as ReadonlyArray<readonly [string, unknown, unknown]>) {
    // TOTAL: a REMOVED section is `undefined`, which `canonicalDigest` cannot
    // serialize. r10's absence of this guard turned "receiptLineage removed"
    // into a throw rather than a verification failure.
    if (published === undefined || published === null) {
      fail(section, `the artifact publishes no ${section}`);
      continue;
    }
    if (canonicalDigest(published as never) !== canonicalDigest(canonical as never)) {
      fail(section, `the published ${section} is not the canonical constant this build produces`);
    }
  }
  checked.push("verificationGuarantee");
  checked.push("pointInTimePolicy");
  checked.push("canonicalProse");

  /*
    THE HISTORICAL RECORD, RE-READ AND RE-HASHED — not compared to itself.

    Every check above compares the artifact against a constant this build
    authored. r15 published `0495c156cc2…` as the SHA-256 of r2 while the file
    hashes to `0495c156fcc2…`, and passed, because nothing here ever opened a
    frozen artifact. A verifier that only compares authored claims to authored
    constants has verified authorship, not facts.

    Every frozen pass is now read at its canonical repository-root path — never
    against `process.cwd()` — hashed, and compared to the record. Missing,
    unreadable and mismatched all fail. The reader is injected so this check can
    be PROVEN capable of failing without touching frozen history.
  */
  for (const pass of D085_REJECTED_PASSES) {
    let bytes: Buffer;
    try {
      bytes = readBytes(pass.path);
    } catch (error) {
      fail("historicalArtifacts", `${pass.contract} (${pass.path}) could not be read (${readFailureCode(error)})`);
      continue;
    }
    if (!Buffer.isBuffer(bytes)) {
      fail("historicalArtifacts", `${pass.contract} (${pass.path}) did not read as bytes`);
      continue;
    }
    const observed = createHash("sha256").update(bytes).digest("hex");
    if (observed !== pass.fileSha256) {
      fail(
        "historicalArtifacts",
        `${pass.contract} (${pass.path}): the record says ${pass.fileSha256}, the file hashes to ${observed}`,
      );
    }
  }
  /*
    ...and the artifact's own published lineage must name the same digests, so
    a document cannot claim a history the record does not hold.
  */
  {
    const publishedRows = Array.isArray(doc.rejectedLineage) ? doc.rejectedLineage as unknown[] : [];
    if (publishedRows.length !== D085_REJECTED_PASSES.length) {
      fail(
        "historicalArtifacts",
        `the artifact publishes ${publishedRows.length} rejected passes; the record holds ${D085_REJECTED_PASSES.length}`,
      );
    }
    for (const [i, pass] of D085_REJECTED_PASSES.entries()) {
      const row = publishedRows[i] as { contract?: unknown; fileSha256?: unknown } | undefined;
      if (row?.contract !== pass.contract || row?.fileSha256 !== pass.fileSha256) {
        fail(
          "historicalArtifacts",
          `the artifact's rejected pass ${i + 1} is ${JSON.stringify(row)}; the record says ` +
          `${JSON.stringify({ contract: pass.contract, fileSha256: pass.fileSha256 })}`,
        );
      }
    }
  }
  checked.push("historicalArtifacts");

  // The limits text is deterministic; it is compared, not merely present.
  if (analysis.limits === undefined || analysis.limits === null) {
    fail("limits", "the artifact publishes no analysis.limits");
  } else if (canonicalDigest(analysis.limits as never) !== canonicalDigest(D085_CANONICAL_LIMITS as never)) {
    fail("limits", "the published analysis.limits are not the canonical deterministic limits");
  }
  checked.push("limits");

  // The write-safety census is RECOMPUTED from the replay cells, not trusted.
  {
    // Recomputed from the SNAPSHOT and the re-derived ledger, exactly as the
    // generator derives it — not read back from the published array.
    const censusLedger = analysis.providerPreflight.localRouteProbes.attempted > 0
      ? recordedProviderLedger(snapshot.bindings)
      : emptyProviderLedger();
    const recomputedCensus = writeSafetyCensusOf(snapshot, censusLedger);
    if (analysis.writeSafetyCensus === undefined || analysis.writeSafetyCensus === null) {
      fail("writeSafetyCensus", "the artifact publishes no write-safety census");
    } else if (canonicalDigest(analysis.writeSafetyCensus as never) !== canonicalDigest(recomputedCensus as never)) {
      fail("writeSafetyCensus", "the published write-safety census is not what recomputing it from the published cells produces");
    }
  }
  checked.push("writeSafetyCensus");

  // (provider-contact evidence is compared to its canonical constant above)
  checked.push("contract");

  // --- pinned bytes ---
  /*
    THE MANIFEST MUST BE COMPLETE, not merely internally consistent.

    r9 iterated whatever the artifact published, so REMOVING an entry — and,
    after Correction 9's hash chain, coherently re-hashing around the removal —
    still passed. The required set is re-derived from the pinned-source
    contract, so a dropped source is a missing source, not a shorter list.
  */
  /*
    THE MANIFEST IS COMPARED TO A TRUSTED TUPLE, and the PATH IS NEVER TAKEN
    FROM THE ARTIFACT.

    r10 validated the key SET and then read `entry.path` from the artifact and
    hashed whatever file that named. Keeping the key `d079` while pointing its
    path at `package.json` — with both hashes set to that file's hash —
    verified clean. A verifier must never let the document under inspection
    choose which file it is checked against.
  */
  /*
    NO SECOND READ. The reconstruction above already performed every trusted
    filesystem read inside the contained boundary, and its manifest carries the
    trusted tuples. r12 re-ran `checkPinnedSources()` and re-read D083/D084
    here, AFTER the try/catch, so a later or racing I/O failure still escaped
    as a throw. The published manifest is compared against the owned
    reconstruction instead.
  */
  {
    const trusted = reconstructed.snapshot.sourceManifest;
    const trustedByKey = new Map(trusted.map((t) => [t.key, t]));
    const published = snapshot.sourceManifest;
    const requiredKeys = trusted.map((t) => t.key).sort();
    const publishedKeys = published.map((e) => (e && typeof e === "object" ? String((e as { key?: unknown }).key) : "(malformed)")).sort();
    if (JSON.stringify(publishedKeys) !== JSON.stringify(requiredKeys)) {
      const missing = requiredKeys.filter((k) => !publishedKeys.includes(k));
      const extra = publishedKeys.filter((k) => !requiredKeys.includes(k));
      fail("pinnedSources", `the source manifest is not the exact required set${missing.length ? `; missing {${missing.join(", ")}}` : ""}${extra.length ? `; unexpected {${extra.join(", ")}}` : ""}`);
    }
    // ORDER matters too: the reconstruction is the canonical sequence.
    if (published.length === trusted.length) {
      for (let i = 0; i < trusted.length; i += 1) {
        if (published[i]?.key !== trusted[i].key) {
          fail("pinnedSources", `the source manifest is not in canonical order at position ${i}`);
          break;
        }
      }
    }
    for (const entry of published) {
      const entryProblems: SchemaProblem[] = [];
      exactMap(entry, "sourceManifest[]", ["key", "path", "expectedSha256", "observedSha256", "matches"], [], entryProblems);
      if (entryProblems.length > 0) { fail("pinnedSources", renderProblems(entryProblems)); continue; }
      const t = trustedByKey.get(entry.key);
      if (!t) { fail("pinnedSources", `the manifest names the unknown source key ${JSON.stringify(entry.key)}`); continue; }
      // Every tuple field must equal the RECONSTRUCTED one. No path supplied by
      // the artifact is ever resolved or read.
      if (entry.path !== t.path) { fail("pinnedSources", `${entry.key} publishes a path that is not the trusted one`); continue; }
      if (entry.expectedSha256 !== t.expectedSha256) { fail("pinnedSources", `${entry.key} publishes an expected hash that is not the trusted pin`); continue; }
      if (entry.observedSha256 !== t.observedSha256) { fail("pinnedSources", `${entry.key} publishes an observed hash that does not match the trusted observation`); }
      if (entry.matches !== true || t.matches !== true) { fail("pinnedSources", `${entry.key} is not recorded as matching`); }
    }
  }
  checked.push("pinnedSources");

  // --- posture ---
  if (snapshot.provenance.databaseAccess !== "none") fail("provenance", "database access is not none");
  if (snapshot.provenance.queriesExecuted !== 0) fail("provenance", "queriesExecuted is not zero");
  if (snapshot.provenance.providerWritesAttempted !== 0) fail("provenance", "a provider write was attempted");
  if (snapshot.provenance.automation !== "off") fail("provenance", "automation is not off");
  if (snapshot.provenance.maximumReachableAuthority !== "validated_only") fail("provenance", "authority ceiling is not validated_only");
  checked.push("provenance");

  // --- the replay is reproduced, not trusted ---
  // Rebuild the ledger from the frozen bindings rather than trusting the
  // published one, so a forged preflight claim cannot survive.
  const pf = analysis.providerPreflight;
  const ledger = pf.localRouteProbes.attempted > 0
    ? recordedProviderLedger(snapshot.bindings)
    : emptyProviderLedger();

  // RE-DERIVED, never trusted. Each counter is checked against the recorded
  // probe, and the three are checked against each other for impossibility.
  if (pf.localRouteProbes.attempted !== ledger.routeProbesAttempted) {
    fail("providerPreflight", `published ${pf.localRouteProbes.attempted} route probes, the recorded probe declares ${ledger.routeProbesAttempted}`);
  }
  if (pf.localRouteProbes.succeeded + pf.localRouteProbes.failed !== pf.localRouteProbes.attempted) {
    fail("providerPreflight", "route probe succeeded + failed does not equal attempted");
  }
  if (pf.localRouteProbes.statuses.length !== pf.localRouteProbes.attempted) {
    fail("providerPreflight", "one HTTP status per route probe is required");
  }
  if (pf.localRouteProbes.methods.some((m) => m !== "GET")) {
    fail("providerPreflight", "a non-GET route probe method was published");
  }
  if (pf.providerContacts.attempted !== ledger.providerContactsAttempted) {
    fail("providerPreflight", `published ${pf.providerContacts.attempted} provider contacts, the recorded probe declares ${ledger.providerContactsAttempted}`);
  }
  if (pf.providerContacts.succeeded > pf.providerContacts.attempted) {
    fail("providerPreflight", `${pf.providerContacts.succeeded} provider contacts succeeded out of ${pf.providerContacts.attempted} attempted — impossible`);
  }
  if (pf.providerContacts.succeeded + pf.providerContacts.failed > pf.providerContacts.attempted) {
    fail("providerPreflight", "provider contact outcomes exceed attempts");
  }
  if (pf.providerContacts.attempted === 0 && pf.providerContacts.succeeded !== 0) {
    fail("providerPreflight", "provider contact succeeded with zero attempts");
  }
  // A read-back cannot exist without a write, and no write occurred.
  if (pf.readbackAttempts.attempted !== 0 || pf.readbackAttempts.classification !== "not_attempted") {
    fail("providerPreflight", "a post-write read-back attempt was published, but no write occurred");
  }
  if (snapshot.provenance.providerWritesAttempted === 0 && pf.readbackAttempts.attempted > 0) {
    fail("providerPreflight", "read-back attempts without any provider write");
  }
  // Provenance must use the SAME semantics as the analysis.
  if (snapshot.provenance.localRouteProbesAttempted !== pf.localRouteProbes.attempted) {
    fail("provenance", "provenance route-probe count disagrees with the analysis");
  }
  if (snapshot.provenance.providerContactsAttempted !== pf.providerContacts.attempted) {
    fail("provenance", "provenance provider-contact count disagrees with the analysis");
  }
  if (snapshot.provenance.readbackAttempts !== pf.readbackAttempts.attempted) {
    fail("provenance", "provenance read-back count disagrees with the analysis");
  }
  if (!pf.semantics.includes("never provider contact")) {
    fail("providerPreflight", "the ledger does not declare that a route probe is not provider contact");
  }
  const recomputed = replay(snapshot, ledger);
  if (canonicalDigest(recomputed.cells) !== canonicalDigest(analysis.cells)) {
    fail("cells", "the published cells are not what replaying the frozen snapshot produces");
  }
  if (canonicalDigest(recomputed.funnel) !== canonicalDigest(analysis.funnel)) {
    fail("funnel", "the published funnel is not what replaying the frozen snapshot produces");
  }
  if (canonicalDigest(recomputed.blockerCensus) !== canonicalDigest(analysis.blockerCensus)) {
    fail("blockerCensus", "the published blocker census is not reproducible");
  }
  checked.push("replay");

  // --- balanced counters, RECOMPUTED rather than trusted ---
  //
  // A published `balanced: true` proves nothing: a forger sets the boolean at
  // the same time as the number. Every one of these is re-derived from the
  // frozen cells and bindings.
  const r = analysis.reconciliation;
  const expectedCells = snapshot.bindings.length * D085_DIRECTIONS.length;
  const observedCells = analysis.cells.length;
  if (r.expectedCells !== expectedCells) fail("reconciliation", `expectedCells is ${r.expectedCells}, re-derived ${expectedCells}`);
  if (r.observedCells !== observedCells) fail("reconciliation", `observedCells is ${r.observedCells}, re-derived ${observedCells}`);
  if (observedCells !== expectedCells) fail("reconciliation", `expected ${expectedCells} cells, observed ${observedCells}`);
  if (r.cellsBalanced !== (observedCells === expectedCells)) fail("reconciliation", "cellsBalanced does not match the re-derived counts");

  const blockedCells = analysis.cells.filter((c) => c.status === "blocked").length;
  const wouldWriteCells = analysis.cells.filter((c) => c.wouldWriteAvailable).length;
  const partitions = blockedCells + wouldWriteCells === observedCells;
  if (!partitions) fail("reconciliation", `blocked ${blockedCells} + would-write ${wouldWriteCells} does not equal ${observedCells} cells`);
  if (r.blockedPlusWouldWriteEqualsCells !== partitions) {
    fail("reconciliation", "blockedPlusWouldWriteEqualsCells does not match the re-derived counts");
  }

  // BOTH denominators, each re-derived. Neither may be called the other.
  const evaluationsFromCells = analysis.cells.reduce((sum, c) => sum + c.candidateEntityOriginEvaluations, 0);
  const uniqueFromBindings = snapshot.bindings.reduce((sum, b) => sum + b.candidateObservations, 0);
  const evaluationsFromBindings = uniqueFromBindings * D085_DIRECTIONS.length;
  const uniqueFromCells = evaluationsFromCells / D085_DIRECTIONS.length;

  if (r.entityOriginDirectionEvaluations !== evaluationsFromCells) {
    fail("reconciliation", `entityOriginDirectionEvaluations is ${r.entityOriginDirectionEvaluations}, re-derived ${evaluationsFromCells} from the cells`);
  }
  if (r.entityOriginDirectionEvaluationsFromBindings !== evaluationsFromBindings) {
    fail("reconciliation", `entityOriginDirectionEvaluationsFromBindings is ${r.entityOriginDirectionEvaluationsFromBindings}, re-derived ${evaluationsFromBindings}`);
  }
  if (r.uniqueEntityOriginObservations !== uniqueFromCells) {
    fail("reconciliation", `uniqueEntityOriginObservations is ${r.uniqueEntityOriginObservations}, re-derived ${uniqueFromCells}`);
  }
  if (r.uniqueEntityOriginObservationsFromBindings !== uniqueFromBindings) {
    fail("reconciliation", `uniqueEntityOriginObservationsFromBindings is ${r.uniqueEntityOriginObservationsFromBindings}, re-derived ${uniqueFromBindings}`);
  }
  // The two must differ by exactly the direction multiplier — publishing one as
  // the other is the exact r2 defect.
  if (r.uniqueEntityOriginObservations * D085_DIRECTIONS.length !== r.entityOriginDirectionEvaluations) {
    fail("reconciliation", `the two denominators are inconsistent: ${r.uniqueEntityOriginObservations} unique x ${D085_DIRECTIONS.length} directions is not ${r.entityOriginDirectionEvaluations}`);
  }
  if (r.uniqueEntityOriginObservations === r.entityOriginDirectionEvaluations && D085_DIRECTIONS.length > 1) {
    fail("reconciliation", "the unique-observation and evaluation denominators are identical, so one is mislabelled");
  }
  if (r.uniqueObservationsBalanced !== (uniqueFromCells === uniqueFromBindings)) {
    fail("reconciliation", "uniqueObservationsBalanced does not match the re-derived sums");
  }
  if (r.evaluationsBalanced !== (evaluationsFromCells === evaluationsFromBindings)) {
    fail("reconciliation", "evaluationsBalanced does not match the re-derived sums");
  }
  if (!r.denominatorSemantics?.includes("ONCE")) {
    fail("reconciliation", "the reconciliation does not declare what each denominator counts");
  }

  // Per-business, per-account and per-direction denominators must re-sum too.
  for (const [label, rows] of [
    ["perBusiness", analysis.perBusiness.map((x) => x.cells)],
    ["perAccount", analysis.perAccount.map((x) => x.cells)],
    ["perDirection", analysis.perDirection.map((x) => x.cells)],
  ] as ReadonlyArray<readonly [string, number[]]>) {
    const sum = rows.reduce((s, n) => s + n, 0);
    if (sum !== observedCells) fail("reconciliation", `${label} cells sum to ${sum}, not ${observedCells}`);
  }
  for (const stage of analysis.funnel) {
    if (stage.survivors < 0 || stage.eliminated < 0) fail("funnel", `${stage.stage} has a negative count`);
    if (!Number.isInteger(stage.survivors)) fail("funnel", `${stage.stage} survivors is not an integer`);
  }
  for (let i = 1; i < analysis.funnel.length; i += 1) {
    const prev = analysis.funnel[i - 1]!, cur = analysis.funnel[i]!;
    if (cur.survivors + cur.eliminated !== prev.survivors) {
      fail("funnel", `${cur.stage} does not balance against ${prev.stage}`);
    }
  }
  checked.push("reconciliation");

  // --- non-vacuity: a zero must be explained ---
  const wouldWrite = analysis.cells.filter((c) => c.wouldWriteAvailable).length;
  if (wouldWrite === 0) {
    if (analysis.blockerCensus.length === 0) fail("nonVacuity", "zero would-write cells with an empty blocker census");
    if (analysis.cells.some((c) => c.blockers.length === 0)) {
      fail("nonVacuity", "a cell produced no would-write request and no blocker");
    }
    if (analysis.cells.some((c) => c.blockerDetail.some((d) => !d.why || d.why.length === 0))) {
      fail("nonVacuity", "a blocker was published without a reason");
    }
  }
  // Every cell must carry the structural blocker while no endpoint exists.
  if (!analysis.cells.every((c) => c.blockers.includes("no_provider_write_path_exists"))) {
    fail("nonVacuity", "a cell omits the structural no-write-path blocker");
  }
  checked.push("nonVacuity");

  // --- authority ceilings ---
  if (analysis.readback.classification !== "not_attempted") fail("readback", "a read-back other than not_attempted was published");
  if (!analysis.readback.everyCellNotAttempted) fail("readback", "a cell claims a read-back classification");
  if (analysis.exposure.spendMoved !== null || analysis.exposure.revenueMoved !== null) {
    fail("exposure", "a moved-spend or moved-revenue figure was published");
  }
  if (analysis.exposure.roasLift !== null || analysis.exposure.profitLift !== null || analysis.exposure.optimalPercent !== null) {
    fail("exposure", "a causal lift or optimal percent was published");
  }
  if (analysis.policyFingerprint !== dryRunPolicyFingerprint()) {
    fail("policy", "the published policy fingerprint is not the current policy");
  }
  checked.push("authority");

  // --- no secret, no route, no token anywhere in the artifact ---
  // THE SNAPSHOT, never the caller's value. r11 stringified the original
  // parameter here, so a Proxy that satisfied the descriptor-based
  // observation and threw on a later `get` escaped the boundary.
  const raw = JSON.stringify(doc);
  for (const forbidden of [
    /graph\.facebook\.com/i, /access_token/i, /Bearer\s+[A-Za-z0-9._-]{12,}/i,
    /postgres(ql)?:\/\//i, /set-cookie/i, /EAA[A-Za-z0-9]{20,}/,
  ]) {
    if (forbidden.test(raw)) fail("redaction", `the artifact contains ${String(forbidden)}`);
  }
  checked.push("redaction");

  return { ok: failures.length === 0, failures, checked };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function runAssemble(ledger?: ProviderReadLedger): Record<string, unknown> {
  const probe = assembleSnapshot(emptyProviderLedger());
  const resolved = ledger ?? recordedProviderLedger(probe.bindings);
  const snapshot = assembleSnapshot(resolved);
  const analysis = replay(snapshot, resolved);
  const snapshotHash = canonicalDigest(snapshot);
  const analysisHash = canonicalDigest(analysis);
  const artifact: Record<string, unknown> = {
    contract: D085_CONTRACT_ID,
    snapshot,
    analysis,
    snapshotHash,
    analysisHash,
    /*
      THE COMPLETE REJECTED LINEAGE, in the artifact a reader actually opens.
      r9 published a list that stopped at v5 while the contract was v9.
    */
    rejectedLineage: canonicalRejectedLineage(),
    receiptLineage: canonicalReceiptLineage(),
    /*
      THE MACHINE-READABLE GUARANTEE, in the generated JSON.

      The r9 report claimed this was published here. It was not — the string
      did not appear in the artifact at all. It is emitted now so a later
      reader can consume it without re-deriving the limitation from prose.
    */
    verificationGuarantee: RECEIPT_VERIFICATION_GUARANTEE,
    /*
      THE EVIDENCE CLASS of the provider-contact assertion, stated honestly.

      The zero-contact claim is derived from this process's own recorded probe
      and re-derived by the generator and verifier from that same record. That
      is self-report, not independent proof, and it is labelled as such.
    */
    providerContactEvidence: D085_PROVIDER_CONTACT_EVIDENCE,
    pointInTimePolicy: PIT_POLICY,
  };
  artifact.artifactHash = canonicalDigest(artifact);
  /*
    GATED AND ATOMIC.

    The gate refuses before any filesystem contact if the target is frozen
    history. The write goes to a sibling temp file and is renamed into place,
    so a partial or failed write cannot truncate an existing artifact either.
  */
  /*
    UNIQUE, EXCLUSIVE, NO-FOLLOW TEMP.

    r12 wrote to the fixed sibling name `<final>.writing` with
    `writeFileSync`, which FOLLOWS SYMLINKS. A pre-existing symlink at that
    name pointing at a frozen artifact truncates the frozen file before the
    rename — the exact accident that destroyed r11, now reachable
    deliberately. The temp is now a unique name in the same directory, created
    with O_CREAT|O_EXCL (and O_NOFOLLOW where the platform provides it) so an
    existing path of ANY kind fails the open, written through the owned
    descriptor, and renamed only after the final target is re-validated.
  */
  const outPath = assertWritableArtifactPath(D085_JSON_OUT);
  const finalPath = d085TrustedPath(outPath);
  // Encoded ONCE as bytes, so the loop below advances in the same unit the
  // write returns. r13 passed a string and a "utf8" encoding to a single
  // writeSync, then ignored the returned count.
  const payload = Buffer.from(`${JSON.stringify(artifact, null, 1)}\n`, "utf8");
  const tempPath = `${finalPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  /*
    OWNERSHIP IS RECORDED ONLY AFTER A SUCCESSFUL EXCLUSIVE OPEN.

    r14's catch unconditionally unlinked `tempPath` — including when
    `openSync` had FAILED before this process ever acquired that path. On an
    EEXIST collision it therefore deleted a file or symlink it did not own,
    reintroducing exactly the harm the exclusive open was added to prevent.
  */
  atomicPublish({
    finalPath, tempPath, payload,
    // RE-VALIDATE immediately before rename: the target must still be exactly
    // the version-derived path and must not be frozen history.
    revalidate: () => {
      assertWritableArtifactPath(outPath);
      if (finalPath !== d085TrustedPath(D085_JSON_OUT)) {
        throw new Error("the resolved output path changed between write and rename");
      }
    },
  });
  console.log(JSON.stringify({
    phase: "d085-assemble",
    databaseQueriesExecuted: 0,
    providerWritesAttempted: 0,
    localRouteProbesAttempted: resolved.routeProbesAttempted,
    providerContactsAttempted: resolved.providerContactsAttempted,
    readbackAttempts: 0,
    providerContactProven: D085_PROVIDER_READ_PROBE.providerContactProven,
    bindings: snapshot.bindings.length,
    cells: analysis.cells.length,
    wouldWriteCells: analysis.cells.filter((c) => c.wouldWriteAvailable).length,
    blockerCodes: analysis.blockerCensus.length,
    snapshotHash, analysisHash, artifactHash: artifact.artifactHash,
  }, null, 1));
  return artifact;
}

export function runVerify(): VerifyResult {
  // The CLI read is contained too: a missing or unreadable artifact is a
  // stable verification failure, not a thrown Error out of the entry point.
  let artifact: unknown;
  try {
    artifact = JSON.parse(readFileSync(d085TrustedPath(D085_JSON_OUT), "utf8"));
  } catch (error) {
    const result: VerifyResult = {
      ok: false,
      failures: [`artifact: the published artifact could not be read (${readFailureCode(error)})`],
      checked: [],
    };
    console.log(JSON.stringify({ phase: "d085-verify", ...result }, null, 1));
    return result;
  }
  const result = verifyArtifact(artifact);
  console.log(JSON.stringify({ phase: "d085-verify", ...result }, null, 1));
  return result;
}

const invoked = process.argv[1] ?? "";
if (invoked.includes("d085-budget-proposal-dry-run")) {
  const mode = process.argv[2] ?? "verify";
  if (mode === "assemble") runAssemble();
  else if (mode === "verify") { if (!runVerify().ok) process.exitCode = 1; }
  else if (mode === "selftest") {
    // Takes nothing, writes only inside a directory it creates and removes.
    const report = publisherSelfTest();
    console.log(JSON.stringify({ phase: "d085-publisher-selftest", ...report }, null, 1));
    if (!report.ok) process.exitCode = 1;
  }
  else { console.error(`unknown mode ${mode}`); process.exitCode = 2; }
}

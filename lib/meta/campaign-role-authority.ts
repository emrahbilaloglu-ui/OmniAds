/**
 * D081-B — automatic, account-scoped, point-in-time campaign-role authority.
 *
 * D080B proved `role_authority_absent` blocked 100% of 247,050 historical
 * proposals: all 3,058 in-window `engine_v3_campaign_context_daily` rows carry
 * a NULL provider account, so no role row could ever authorise an
 * account-scoped change.
 *
 * This module is the missing authority. It resolves a campaign's role from
 * AUTOMATIC inference only, keyed by the full composite scope — business,
 * provider account, campaign and as-of date — and fails closed on every way
 * that scope can be unproven.
 *
 * What it deliberately refuses to do:
 *
 * - it never accepts a human-authored Test/Main/Mixed label, and there is no
 *   input on this contract through which one could be supplied;
 * - it never infers account scope from the business alone, from a campaign
 *   name, from a display label, or from array position;
 * - it never treats a separately valid account id as proof that THIS campaign
 *   belonged to it. The account must be established by an observed identity
 *   join at or before the as-of date.
 *
 * Names are labels, not bindings. A campaign called "TEST - scale" proves
 * nothing, and this module will not read it.
 */
import { isCampaignContextResolverAuthorityValidated } from "@/lib/creative-decision-engine/campaign-context/source";

/** The only role kinds automatic inference may produce. */
export const AUTOMATIC_CAMPAIGN_ROLES = ["test", "main", "mixed"] as const;
export type AutomaticCampaignRole = (typeof AUTOMATIC_CAMPAIGN_ROLES)[number];

/** Confidence classes the inference job already emits. */
export const ROLE_CONFIDENCE_CLASSES = ["high", "medium", "low"] as const;
export type RoleConfidenceClass = (typeof ROLE_CONFIDENCE_CLASSES)[number];

/** Only `resolved` may satisfy role authority; the rest are fail-closed. */
export const ROLE_AUTHORITY_STATUSES = ["resolved", "conflict", "unknown"] as const;
export type RoleAuthorityStatus = (typeof ROLE_AUTHORITY_STATUSES)[number];

/**
 * D081 C1 — the resolver version this audit will accept, and the canonical
 * validator it defers to. The runtime rule is `source === "system_inferred"`
 * AND `confidence_class === "high"` AND a validated resolver version; this
 * module reuses that rule rather than inventing a weaker second one.
 */
export const ROLE_AUTHORITY_BLOCKERS = [
  "role_evidence_absent",
  "role_account_scope_absent",
  "role_account_cross_paired",
  "role_identity_join_absent",
  "role_identity_ambiguous",
  "role_evidence_conflict",
  "role_evidence_stale",
  "role_evidence_future",
  "role_kind_unrecognised",
  "role_confidence_unrecognised",
  "role_confidence_not_high",
  "role_business_cross_paired",
  "role_resolver_version_absent",
  "role_resolver_version_unvalidated",
  "role_source_not_system_inferred",
] as const;
export type RoleAuthorityBlocker = (typeof ROLE_AUTHORITY_BLOCKERS)[number];

/**
 * One automatic inference row, exactly as the job wrote it.
 *
 * There is no `manualKind`, `override`, or `label` field, and adding one would
 * be a contract change a test refuses.
 */
export interface AutomaticRoleEvidenceRow {
  businessId: string;
  /**
   * The resolver build that produced the row. Absent means the provenance was
   * never retained, which fails closed: it is not evidence that the approved
   * resolver ran.
   */
  resolverVersion?: string | null;
  /** May be null: that is precisely the historical gap this module closes. */
  providerAccountId: string | null;
  campaignId: string;
  asOfDate: string;
  inferredKind: string | null;
  confidenceClass: string | null;
  /**
   * Where the inference came from. Required: only the exact string
   * `system_inferred` carries authority, and an omitted field would otherwise
   * read as "probably automatic".
   */
  kindSource: string | null;
}

/**
 * An observed campaign/account identity, from provider observation rather than
 * from the inference job. This is what supplies account scope when the
 * inference row lacks it.
 */
export interface ObservedCampaignIdentity {
  businessId: string;
  providerAccountId: string;
  campaignId: string;
  /** The day the identity was observed; later observations are not knowable. */
  observedOn: string;
}

export interface RoleAuthorityRequest {
  businessId: string;
  providerAccountId: string;
  campaignId: string;
  /** The origin. Nothing dated after this may be consulted. */
  asOfDate: string;
  /** How old inference evidence may be and still carry authority. */
  maxEvidenceAgeDays: number;
}

/**
 * The canonical authority rule, injected so this module cannot drift from the
 * runtime one. Production passes
 * `isCampaignContextResolverAuthorityValidated`; a test passes a stub to prove
 * both branches. With no validator supplied, nothing validates and every row
 * fails closed.
 */
export type ResolverVersionValidator = (resolverVersion: string | null | undefined) => boolean;

export interface RoleAuthorityResolution {
  status: RoleAuthorityStatus;
  role: AutomaticCampaignRole | null;
  confidence: RoleConfidenceClass | null;
  /** True only for a resolved, fresh, account-scoped automatic result. */
  satisfiesRoleAuthority: boolean;
  blockers: RoleAuthorityBlocker[];
  provenance: {
    /** Always "automatic_inference". There is no other producer. */
    producer: "automatic_inference";
    evidenceAsOf: string | null;
    evidenceAgeDays: number | null;
    accountScope: "row_scoped" | "identity_join" | "absent";
    identityObservedOn: string | null;
    candidatesConsidered: number;
    /** The resolver build behind the decision, or null when never retained. */
    resolverVersion: string | null;
    resolverVersionValidated: boolean;
    /** The exact confidence the canonical rule requires. */
    requiredConfidence: "high";
  };
  notes: string[];
}

/**
 * The ONLY source that may carry authority. This is an allow-list, not a
 * deny-list: an earlier form refused a handful of known manual origins and let
 * everything else through, so `null`, `unknown`, `batch_import` and
 * `legacy_label` all resolved. Anything that is not exactly this string fails
 * closed, and the source is never inferred from a table name.
 */
export const REQUIRED_KIND_SOURCE = "system_inferred" as const;

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  return value === null || value === undefined ? null : String(value);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

/**
 * Resolves account-scoped automatic role authority at a point in time.
 *
 * Every rejection path returns a blocker rather than a fallback. There is no
 * branch that returns a role because one was "probably" intended.
 */
export function resolveCampaignRoleAuthority(input: {
  request: RoleAuthorityRequest;
  /** Candidate inference rows. Rows for other campaigns are ignored, not merged. */
  evidence: AutomaticRoleEvidenceRow[];
  /** Observed identities used ONLY to establish account scope. */
  identities: ObservedCampaignIdentity[];
  /**
   * The canonical resolver-version validator. Omitted means nothing validates,
   * which is the correct fail-closed default rather than a free pass.
   */
  isResolverVersionValidated?: ResolverVersionValidator;
}): RoleAuthorityResolution {
  const { request, evidence, identities } = input;
  const isResolverVersionValidated = input.isResolverVersionValidated ?? (() => false);
  const blockers: RoleAuthorityBlocker[] = [];
  const notes: string[] = [];
  const deny = (
    status: RoleAuthorityStatus,
    accountScope: RoleAuthorityResolution["provenance"]["accountScope"],
    candidates: number,
    evidenceAsOf: string | null = null,
    identityObservedOn: string | null = null,
    resolverVersion: string | null = null,
    resolverVersionValidated = false,
  ): RoleAuthorityResolution => ({
    status, role: null, confidence: null, satisfiesRoleAuthority: false,
    blockers: [...new Set(blockers)],
    provenance: {
      producer: "automatic_inference", evidenceAsOf,
      evidenceAgeDays: evidenceAsOf ? daysBetween(evidenceAsOf, request.asOfDate) : null,
      accountScope, identityObservedOn, candidatesConsidered: candidates,
      resolverVersion, resolverVersionValidated, requiredConfidence: "high",
    },
    notes,
  });

  if (!isCalendarDate(request.asOfDate)) {
    blockers.push("role_evidence_absent");
    notes.push("the request carries no real as-of date, so nothing can be bounded by it");
    return deny("unknown", "absent", 0);
  }

  // Candidates must match the FULL composite scope, not just the campaign id.
  // An earlier form filtered on `campaignId` alone, so a row belonging to a
  // different business — with the same campaign id, which is only unique inside
  // an account — was accepted as evidence for this one.
  const sameCampaign = evidence.filter((row) => row.campaignId === request.campaignId);
  const foreignBusiness = sameCampaign.filter((row) => row.businessId !== request.businessId);
  if (foreignBusiness.length > 0 && foreignBusiness.length === sameCampaign.length) {
    blockers.push("role_business_cross_paired");
    notes.push("every inference row with this campaign id belongs to a different business; the same id in another business is a different campaign");
    return deny("conflict", "absent", sameCampaign.length);
  }
  if (foreignBusiness.length > 0) {
    blockers.push("role_business_cross_paired");
    notes.push(`${foreignBusiness.length} inference row(s) with this campaign id belong to a different business`);
    return deny("conflict", "absent", sameCampaign.length);
  }
  const forCampaign = sameCampaign.filter((row) => row.businessId === request.businessId);
  const knowable = forCampaign.filter(
    (row) => isCalendarDate(row.asOfDate) && row.asOfDate <= request.asOfDate,
  );
  if (forCampaign.length > 0 && knowable.length === 0) {
    blockers.push("role_evidence_future");
    notes.push("every inference row for this campaign is dated after the origin and is therefore not knowable here");
    return deny("unknown", "absent", forCampaign.length);
  }
  if (knowable.length === 0) {
    blockers.push("role_evidence_absent");
    notes.push("no automatic inference row exists for this campaign at or before the origin");
    return deny("unknown", "absent", 0);
  }

  // The source must be EXACTLY the automatic one. A row that does not say so
  // is not evidence that the automatic resolver produced it, whatever else it
  // says, and it may not act as a tie-breaker either.
  const wrongSource = knowable.filter(
    // Exact equality, with no trimming or case folding: a value that needs
    // normalising to match is not the value the writer emitted.
    (row) => row.kindSource !== REQUIRED_KIND_SOURCE,
  );
  if (wrongSource.length > 0) {
    blockers.push("role_source_not_system_inferred");
    const observed = [...new Set(wrongSource.map((r) => JSON.stringify(r.kindSource ?? null)))].sort();
    notes.push(`${wrongSource.length} candidate row(s) do not declare source ${REQUIRED_KIND_SOURCE} (observed ${observed.join(", ")}); a row whose origin is absent or non-automatic is never authority and is not used as a tie-breaker`);
    return deny("unknown", "absent", knowable.length);
  }

  // --- account scope, the whole point of this module ----------------------
  const rowScoped = knowable.filter((row) => row.providerAccountId !== null);
  const wrongAccount = rowScoped.filter((row) => row.providerAccountId !== request.providerAccountId);
  if (wrongAccount.length > 0) {
    blockers.push("role_account_cross_paired");
    notes.push("an inference row for this campaign names a different provider account; the same campaign id in another account is a different campaign");
    return deny("conflict", "row_scoped", knowable.length);
  }

  let accountScope: RoleAuthorityResolution["provenance"]["accountScope"] = "absent";
  let identityObservedOn: string | null = null;
  const scoped = rowScoped.filter((row) => row.providerAccountId === request.providerAccountId);

  if (scoped.length > 0) {
    accountScope = "row_scoped";
  } else {
    // The row carries no account, so scope must come from an observed identity
    // join at or before the origin. Business alone is never enough.
    const joins = identities.filter(
      (id) =>
        id.campaignId === request.campaignId &&
        id.businessId === request.businessId &&
        isCalendarDate(id.observedOn) &&
        id.observedOn <= request.asOfDate,
    );
    const accounts = new Set(joins.map((j) => j.providerAccountId));
    if (joins.length === 0) {
      blockers.push("role_identity_join_absent");
      notes.push("the inference row carries no provider account and no observed identity joins this campaign to one at or before the origin");
      return deny("unknown", "absent", knowable.length);
    }
    if (accounts.size > 1) {
      blockers.push("role_identity_ambiguous");
      notes.push(`observed identities place this campaign in ${accounts.size} different accounts; the binding is ambiguous and cannot be guessed`);
      return deny("conflict", "absent", knowable.length);
    }
    const only = [...accounts][0]!;
    if (only !== request.providerAccountId) {
      blockers.push("role_account_cross_paired");
      notes.push("the observed identity places this campaign in a different account than the one requested");
      return deny("conflict", "identity_join", knowable.length);
    }
    accountScope = "identity_join";
    identityObservedOn = joins.map((j) => j.observedOn).sort().at(-1) ?? null;
  }

  const candidates = scoped.length > 0 ? scoped : knowable;
  const newestDate = candidates.map((r) => r.asOfDate).sort().at(-1)!;
  const newest = candidates.filter((r) => r.asOfDate === newestDate);

  // Two different kinds on the same day is a conflict, never a coin flip.
  const kinds = new Set(newest.map((r) => String(r.inferredKind ?? "").trim().toLowerCase()));
  if (kinds.size > 1) {
    blockers.push("role_evidence_conflict");
    notes.push(`the newest knowable evidence disagrees: ${[...kinds].sort().join(", ")}`);
    return deny("conflict", accountScope, candidates.length, newestDate, identityObservedOn);
  }
  const kind = [...kinds][0] ?? "";
  if (!(AUTOMATIC_CAMPAIGN_ROLES as readonly string[]).includes(kind)) {
    blockers.push("role_kind_unrecognised");
    notes.push(`inferred kind ${JSON.stringify(kind)} is not one this contract recognises`);
    return deny("unknown", accountScope, candidates.length, newestDate, identityObservedOn);
  }
  const confidence = String(newest[0]!.confidenceClass ?? "").trim().toLowerCase();
  if (!(ROLE_CONFIDENCE_CLASSES as readonly string[]).includes(confidence)) {
    blockers.push("role_confidence_unrecognised");
    notes.push(`confidence class ${JSON.stringify(confidence)} is not one this contract recognises`);
    return deny("unknown", accountScope, candidates.length, newestDate, identityObservedOn);
  }
  // The canonical runtime rule is high confidence only. An earlier form
  // accepted medium and low, which was a weaker second rule the runtime does
  // not honour.
  if (confidence !== "high") {
    blockers.push("role_confidence_not_high");
    notes.push(`confidence ${confidence} does not meet the canonical requirement of high`);
    return deny("unknown", accountScope, candidates.length, newestDate, identityObservedOn);
  }
  // And the approved resolver build must be provable. Absent provenance is not
  // evidence that the approved resolver ran.
  const resolverVersion = text(newest[0]!.resolverVersion);
  if (resolverVersion === null) {
    blockers.push("role_resolver_version_absent");
    notes.push("the row carries no resolver version, so the approved resolver cannot be proven to have produced it");
    return deny("unknown", accountScope, candidates.length, newestDate, identityObservedOn, null, false);
  }
  if (!isResolverVersionValidated(resolverVersion)) {
    blockers.push("role_resolver_version_unvalidated");
    notes.push(`resolver version ${JSON.stringify(resolverVersion)} is not the approved authority version`);
    return deny("unknown", accountScope, candidates.length, newestDate, identityObservedOn, resolverVersion, false);
  }

  const ageDays = daysBetween(newestDate, request.asOfDate);
  if (ageDays > request.maxEvidenceAgeDays) {
    blockers.push("role_evidence_stale");
    notes.push(`the newest knowable inference is ${ageDays} days old, beyond the declared ${request.maxEvidenceAgeDays}-day limit`);
    return deny("unknown", accountScope, candidates.length, newestDate, identityObservedOn);
  }

  return {
    status: "resolved",
    role: kind as AutomaticCampaignRole,
    confidence: confidence as RoleConfidenceClass,
    satisfiesRoleAuthority: true,
    blockers: [],
    provenance: {
      producer: "automatic_inference", evidenceAsOf: newestDate, evidenceAgeDays: ageDays,
      accountScope, identityObservedOn, candidatesConsidered: candidates.length,
      resolverVersion, resolverVersionValidated: true, requiredConfidence: "high",
    },
    notes: [
      accountScope === "row_scoped"
        ? "account scope came from the inference row itself"
        : "account scope came from an observed campaign/account identity at or before the origin",
    ],
  };
}


/**
 * D081 C1 — the canonical entry point.
 *
 * It binds this module to the SAME resolver-version validator the decision
 * surface uses (`isCampaignContextResolverAuthorityValidated`), so role
 * authority here cannot drift into a weaker second rule. Callers that need to
 * exercise both branches inject their own validator through
 * {@link resolveCampaignRoleAuthority}.
 */
export function resolveCanonicalCampaignRoleAuthority(input: {
  request: RoleAuthorityRequest;
  evidence: AutomaticRoleEvidenceRow[];
  identities: ObservedCampaignIdentity[];
}): RoleAuthorityResolution {
  return resolveCampaignRoleAuthority({
    ...input,
    isResolverVersionValidated: isCampaignContextResolverAuthorityValidated,
  });
}

/** The exact rule this module enforces, published so a reader can check it. */
export const CANONICAL_ROLE_AUTHORITY_RULE = {
  producer: "automatic_inference",
  requiredSource: "system_inferred",
  requiredConfidence: "high",
  requiresValidatedResolverVersion: true,
  requiresExactCompositeScope: ["businessId", "providerAccountId", "campaignId", "asOfDate"],
  manualLabelAccepted: false,
  campaignNameConsulted: false,
  reference: "lib/meta/decisions-workspace-read-model.ts trustedForAction",
} as const;

/**
 * D081 C2 — the pure, dependency-free core of the authority rule.
 *
 * The full resolver above adds composite-scope and point-in-time selection on
 * top of this; the canonical read path needs only the rule itself, applied to
 * a context row it has already scoped and dated. Both go through this one
 * function, so a second rule cannot appear.
 *
 * It imports nothing, so wiring it into the read path creates no cycle.
 */
export function evaluateAccountScopedRoleAuthority(input: {
  kind: string | null;
  source: string | null;
  confidenceClass: string | null;
  resolverVersion: string | null;
  isResolverVersionValidated: ResolverVersionValidator;
}): { satisfiesRoleAuthority: boolean; blocker: RoleAuthorityBlocker | null } {
  if (!input.kind || !(AUTOMATIC_CAMPAIGN_ROLES as readonly string[]).includes(input.kind)) {
    return { satisfiesRoleAuthority: false, blocker: "role_kind_unrecognised" };
  }
  if (input.source !== REQUIRED_KIND_SOURCE) {
    return { satisfiesRoleAuthority: false, blocker: "role_source_not_system_inferred" };
  }
  if (input.confidenceClass !== "high") {
    return { satisfiesRoleAuthority: false, blocker: "role_confidence_not_high" };
  }
  if (input.resolverVersion === null) {
    return { satisfiesRoleAuthority: false, blocker: "role_resolver_version_absent" };
  }
  if (!input.isResolverVersionValidated(input.resolverVersion)) {
    return { satisfiesRoleAuthority: false, blocker: "role_resolver_version_unvalidated" };
  }
  return { satisfiesRoleAuthority: true, blocker: null };
}

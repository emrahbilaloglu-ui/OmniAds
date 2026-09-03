import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AUTOMATIC_CAMPAIGN_ROLES,
  CANONICAL_ROLE_AUTHORITY_RULE,
  ROLE_AUTHORITY_BLOCKERS,
  resolveCampaignRoleAuthority,
  resolveCanonicalCampaignRoleAuthority,
  type AutomaticRoleEvidenceRow,
  type ObservedCampaignIdentity,
  type RoleAuthorityRequest,
} from "@/lib/meta/campaign-role-authority";

const BIZ = "biz-1";
const ACCT = "act_1000000000001";
const OTHER_ACCT = "act_2000000000002";
const CAMPAIGN = "c-1";

const request = (over: Partial<RoleAuthorityRequest> = {}): RoleAuthorityRequest => ({
  businessId: BIZ, providerAccountId: ACCT, campaignId: CAMPAIGN,
  asOfDate: "2026-08-01", maxEvidenceAgeDays: 14, ...over,
});
/** Only the declared input surface: `export interface` bodies. */
function declaredInterfaces(file: string): string {
  const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return [...src.matchAll(/export interface [A-Za-z]+ \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
}
/** The executable body: comments and the published rule constant removed. */
function executableBody(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/export const CANONICAL_ROLE_AUTHORITY_RULE[\s\S]*?\} as const;/, "");
}

const APPROVED_RESOLVER = "campaign-context-resolver-v3";
const validator = (v: string | null | undefined) => v === APPROVED_RESOLVER;
const row = (over: Partial<AutomaticRoleEvidenceRow> = {}): AutomaticRoleEvidenceRow => ({
  businessId: BIZ, providerAccountId: ACCT, campaignId: CAMPAIGN,
  asOfDate: "2026-07-28", inferredKind: "main", confidenceClass: "high",
  resolverVersion: APPROVED_RESOLVER, kindSource: "system_inferred", ...over,
});
const identity = (over: Partial<ObservedCampaignIdentity> = {}): ObservedCampaignIdentity => ({
  businessId: BIZ, providerAccountId: ACCT, campaignId: CAMPAIGN, observedOn: "2026-07-20", ...over,
});
const resolve = (evidence: AutomaticRoleEvidenceRow[], identities: ObservedCampaignIdentity[] = [], req = request()) =>
  resolveCampaignRoleAuthority({ request: req, evidence, identities, isResolverVersionValidated: validator });

describe("D081-B — account-scoped automatic role authority", () => {
  it("resolves when the inference row itself carries the account", () => {
    const r = resolve([row()]);
    expect(r.status).toBe("resolved");
    expect(r.role).toBe("main");
    expect(r.satisfiesRoleAuthority).toBe(true);
    expect(r.provenance.accountScope).toBe("row_scoped");
    expect(r.provenance.producer).toBe("automatic_inference");
    expect(r.blockers).toEqual([]);
  });

  it("resolves an account-less row ONLY through an observed identity join", () => {
    // This is the historical case: all 3,058 in-window rows had a null account.
    const withoutJoin = resolve([row({ providerAccountId: null })]);
    expect(withoutJoin.satisfiesRoleAuthority).toBe(false);
    expect(withoutJoin.blockers).toContain("role_identity_join_absent");

    const withJoin = resolve([row({ providerAccountId: null })], [identity()]);
    expect(withJoin.status).toBe("resolved");
    expect(withJoin.satisfiesRoleAuthority).toBe(true);
    expect(withJoin.provenance.accountScope).toBe("identity_join");
    expect(withJoin.provenance.identityObservedOn).toBe("2026-07-20");
  });

  it("never infers account scope from the business alone", () => {
    // An identity for a DIFFERENT campaign in the same business must not scope
    // this one, however tempting the business match is.
    const r = resolve([row({ providerAccountId: null })], [identity({ campaignId: "c-other" })]);
    expect(r.satisfiesRoleAuthority).toBe(false);
    expect(r.blockers).toContain("role_identity_join_absent");
  });

  it("refuses the same campaign id living in a different account", () => {
    const rowSide = resolve([row({ providerAccountId: OTHER_ACCT })]);
    expect(rowSide.status).toBe("conflict");
    expect(rowSide.blockers).toContain("role_account_cross_paired");

    const joinSide = resolve([row({ providerAccountId: null })], [identity({ providerAccountId: OTHER_ACCT })]);
    expect(joinSide.status).toBe("conflict");
    expect(joinSide.blockers).toContain("role_account_cross_paired");
  });

  it("refuses an ambiguous identity that places one campaign in two accounts", () => {
    const r = resolve([row({ providerAccountId: null })], [identity(), identity({ providerAccountId: OTHER_ACCT })]);
    expect(r.status).toBe("conflict");
    expect(r.blockers).toContain("role_identity_ambiguous");
    expect(r.satisfiesRoleAuthority).toBe(false);
  });

  it("refuses a cross-paired business on the identity join", () => {
    const r = resolve([row({ providerAccountId: null })], [identity({ businessId: "biz-other" })]);
    expect(r.satisfiesRoleAuthority).toBe(false);
    expect(r.blockers).toContain("role_identity_join_absent");
  });

  it("never consults a fact dated after the origin", () => {
    const future = resolve([row({ asOfDate: "2026-08-15" })]);
    expect(future.status).toBe("unknown");
    expect(future.blockers).toContain("role_evidence_future");
    expect(future.satisfiesRoleAuthority).toBe(false);
    // The same fact becomes usable once the origin advances past it.
    const later = resolve([row({ asOfDate: "2026-08-15" })], [], request({ asOfDate: "2026-08-20" }));
    expect(later.status).toBe("resolved");
  });

  it("refuses an identity observed only after the origin", () => {
    const r = resolve([row({ providerAccountId: null })], [identity({ observedOn: "2026-08-20" })]);
    expect(r.blockers).toContain("role_identity_join_absent");
  });

  it("refuses evidence older than the declared freshness limit", () => {
    const r = resolve([row({ asOfDate: "2026-06-01" })]);
    expect(r.status).toBe("unknown");
    expect(r.blockers).toContain("role_evidence_stale");
    expect(r.provenance.evidenceAgeDays).toBe(61);
  });

  it("refuses two different kinds on the same newest day", () => {
    const r = resolve([row({ inferredKind: "main" }), row({ inferredKind: "test" })]);
    expect(r.status).toBe("conflict");
    expect(r.blockers).toContain("role_evidence_conflict");
  });

  it("uses the newest knowable row and ignores superseded ones", () => {
    const r = resolve([row({ asOfDate: "2026-07-01", inferredKind: "test" }), row({ asOfDate: "2026-07-28", inferredKind: "main" })]);
    expect(r.role).toBe("main");
    expect(r.provenance.evidenceAsOf).toBe("2026-07-28");
  });

  it("refuses an unrecognised kind or confidence", () => {
    expect(resolve([row({ inferredKind: "winner" })]).blockers).toContain("role_kind_unrecognised");
    expect(resolve([row({ confidenceClass: "extremely-sure" })]).blockers).toContain("role_confidence_unrecognised");
    expect(resolve([row({ confidenceClass: "medium" })]).blockers).toContain("role_confidence_not_high");
    expect(resolve([row({ inferredKind: null })]).blockers).toContain("role_kind_unrecognised");
  });

  it("returns no role at all when it cannot resolve one", () => {
    for (const denied of [resolve([]), resolve([row({ inferredKind: "nope" })]), resolve([row({ providerAccountId: OTHER_ACCT })])]) {
      expect(denied.role).toBeNull();
      expect(denied.confidence).toBeNull();
      expect(denied.satisfiesRoleAuthority).toBe(false);
    }
  });

  it("keeps every emitted blocker inside the declared set", () => {
    const seen = [
      resolve([]), resolve([row({ providerAccountId: OTHER_ACCT })]),
      resolve([row({ asOfDate: "2026-08-15" })]), resolve([row({ asOfDate: "2026-06-01" })]),
      resolve([row({ inferredKind: "x" })]), resolve([row({ confidenceClass: "x" })]),
      resolve([row({ providerAccountId: null })]),
      resolve([row({ providerAccountId: null })], [identity(), identity({ providerAccountId: OTHER_ACCT })]),
      resolve([row({ inferredKind: "main" }), row({ inferredKind: "test" })]),
    ].flatMap((r) => r.blockers);
    expect(seen.length).toBeGreaterThan(5);
    for (const b of seen) expect(ROLE_AUTHORITY_BLOCKERS as readonly string[]).toContain(b);
  });
});

describe("D081-B — a manual label can never change the result", () => {
  it("refuses any row whose origin declares a human author", () => {
    for (const manual of ["manual", "user", "operator_override", "admin", "MANUAL_LABEL", " Override "]) {
      const r = resolve([row({ kindSource: manual })]);
      expect(r.satisfiesRoleAuthority, manual).toBe(false);
      expect(r.blockers, manual).toContain("role_source_not_system_inferred");
      expect(r.role, manual).toBeNull();
    }
  });

  it("does not let a manual row break a tie in favour of anything", () => {
    // A manual row alongside a good automatic one must not be a tie-breaker:
    // the whole resolution fails closed rather than quietly preferring one.
    const r = resolve([row({ kindSource: "system_inferred" }), row({ inferredKind: "test", kindSource: "manual" })]);
    expect(r.satisfiesRoleAuthority).toBe(false);
    expect(r.notes.join(" ")).toContain("not used as a tie-breaker");
  });

  it("accepts ONLY the automatic origin the inference job actually writes", () => {
    expect(resolve([row({ kindSource: "system_inferred" })]).satisfiesRoleAuthority).toBe(true);
    // Independently reproduced as a false accept: an absent source resolved.
    const absent = resolve([row({ kindSource: null })]);
    expect(absent.satisfiesRoleAuthority).toBe(false);
    expect(absent.blockers).toContain("role_source_not_system_inferred");
  });

  it.each(["unknown", "batch_import", "legacy_label", "user_override", "bulk_apply_confirmed", "", "SYSTEM_INFERRED", "system_inferred "])(
    "refuses source %j",
    (kindSource) => {
      const r = resolve([row({ kindSource })]);
      expect(r.satisfiesRoleAuthority).toBe(false);
      expect(r.blockers).toContain("role_source_not_system_inferred");
      expect(r.role).toBeNull();
    },
  );

  it("never infers the source from anything else on the row", () => {
    // Perfect scope, high confidence, validated resolver, right kind — and
    // still refused, because the origin itself is not stated.
    const r = resolve([row({ kindSource: undefined as unknown as string })]);
    expect(r.satisfiesRoleAuthority).toBe(false);
    expect(r.blockers).toContain("role_source_not_system_inferred");
  });

  it("has no field through which a manual label could be supplied", () => {
    // Fail-first by construction: the contract has no such input, so this test
    // fails the moment one is added.
    // The claim is "no INPUT FIELD exists", so the guard reads the declared
    // input surface. Scanning the whole file would trip on the module's own
    // prose and on the published rule that says these are refused — both of
    // which are the opposite of a violation.
    const inputSurface = declaredInterfaces("lib/meta/campaign-role-authority.ts");
    for (const forbidden of ["manualKind", "manualLabel", "overrideKind", "userKind", "labeledBy", "campaign_kind", "campaignName"]) {
      expect(inputSurface, forbidden).not.toContain(forbidden);
    }
    // And the guard must still be able to see the fields that do exist.
    expect(inputSurface).toContain("inferredKind");
    expect(inputSurface).toContain("resolverVersion");
  });

  it("never reads a campaign name", () => {
    // Names are labels, not bindings. This module has no name input at all, so
    // a rename cannot move authority through it.
    // No name is declared as an input, and no name is read anywhere in the
    // executable body. The published rule constant states the same thing, and
    // is excluded so the declaration cannot satisfy its own claim.
    expect(declaredInterfaces("lib/meta/campaign-role-authority.ts")).not.toMatch(/campaignName|campaign_name/);
    expect(executableBody("lib/meta/campaign-role-authority.ts")).not.toMatch(/\.name\b|campaignName|campaign_name/);
    const r = resolve([row()]);
    expect(Object.keys(r.provenance)).not.toContain("name");
  });

  it("declares exactly the three automatic roles and no manual vocabulary", () => {
    expect([...AUTOMATIC_CAMPAIGN_ROLES]).toEqual(["test", "main", "mixed"]);
  });
});

describe("D081-B — the residual manual-label bridge stays out of runtime", () => {
  it("keeps buildCreativeCampaignLabelMap unimported by app, components and lib", () => {
    // It stamps contextTrust "high" from manual label rows. Today its callers
    // are all under scripts/ and _analysis/; this pins that so a runtime caller
    // cannot be added silently.
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(
      "grep -rln 'buildCreativeCampaignLabelMap' app components lib 2>/dev/null || true",
      { encoding: "utf8" },
    ).trim();
    const importers = out.split("\n").filter(Boolean).filter((f) => !f.includes("campaign-label-guard.ts") && !f.endsWith(".test.ts"));
    expect(importers, `unexpected runtime importer(s): ${JSON.stringify(importers)}`).toEqual([]);
  });
});


describe("D081 C1 — the composite scope is the whole key", () => {
  it("refuses row-scoped evidence from another business with the same campaign id", () => {
    // Independently reproduced: this returned satisfiesRoleAuthority: true.
    const r = resolve([row({ businessId: "biz-other" })]);
    expect(r.satisfiesRoleAuthority).toBe(false);
    expect(r.status).toBe("conflict");
    expect(r.blockers).toContain("role_business_cross_paired");
  });

  it("refuses account-null evidence from another business even with a valid identity", () => {
    // Also independently reproduced as a false accept: the identity join was
    // correct, but the evidence itself belonged to a different business.
    const r = resolve(
      [row({ businessId: "biz-other", providerAccountId: null })],
      [identity()],
    );
    expect(r.satisfiesRoleAuthority).toBe(false);
    expect(r.blockers).toContain("role_business_cross_paired");
  });

  it("still resolves when the whole composite scope agrees", () => {
    expect(resolve([row()]).satisfiesRoleAuthority).toBe(true);
    expect(resolve([row({ providerAccountId: null })], [identity()]).satisfiesRoleAuthority).toBe(true);
  });

  it("keeps a mixed batch fail-closed rather than picking the matching row", () => {
    const r = resolve([row(), row({ businessId: "biz-other" })]);
    expect(r.satisfiesRoleAuthority).toBe(false);
    expect(r.blockers).toContain("role_business_cross_paired");
  });
});

describe("D081 C1 — only the canonical confidence and resolver version grant authority", () => {
  it.each(["medium", "low"])("refuses %s confidence", (confidenceClass) => {
    // Independently reproduced: both returned satisfiesRoleAuthority: true.
    const r = resolve([row({ confidenceClass })]);
    expect(r.satisfiesRoleAuthority).toBe(false);
    expect(r.blockers).toContain("role_confidence_not_high");
    expect(r.role).toBeNull();
  });

  it("refuses unknown and conflict confidence", () => {
    expect(resolve([row({ confidenceClass: "unknown" })]).blockers).toContain("role_confidence_unrecognised");
    expect(resolve([row({ confidenceClass: "conflict" })]).blockers).toContain("role_confidence_unrecognised");
  });

  it("refuses a missing resolver version", () => {
    const r = resolve([row({ resolverVersion: null })]);
    expect(r.satisfiesRoleAuthority).toBe(false);
    expect(r.blockers).toContain("role_resolver_version_absent");
    expect(r.provenance.resolverVersionValidated).toBe(false);
  });

  it("refuses an unvalidated resolver version", () => {
    const r = resolve([row({ resolverVersion: "resolver-v1-retired" })]);
    expect(r.satisfiesRoleAuthority).toBe(false);
    expect(r.blockers).toContain("role_resolver_version_unvalidated");
    expect(r.provenance.resolverVersion).toBe("resolver-v1-retired");
  });

  it("accepts only the validated version, and defaults to refusing", () => {
    expect(resolve([row()]).satisfiesRoleAuthority).toBe(true);
    // With NO validator injected, nothing validates: the default is refusal,
    // not a free pass.
    const noValidator = resolveCampaignRoleAuthority({
      request: request(), evidence: [row()], identities: [],
    });
    expect(noValidator.satisfiesRoleAuthority).toBe(false);
    expect(noValidator.blockers).toContain("role_resolver_version_unvalidated");
  });

  it("publishes the resolver provenance on every outcome", () => {
    const ok = resolve([row()]);
    expect(ok.provenance.resolverVersion).toBe(APPROVED_RESOLVER);
    expect(ok.provenance.resolverVersionValidated).toBe(true);
    expect(ok.provenance.requiredConfidence).toBe("high");
  });

  it("uses the canonical validator through the canonical entry point", () => {
    // The canonical entry point defers to
    // isCampaignContextResolverAuthorityValidated, which reads an approved
    // version from the environment. Unset here, so it must fail closed.
    const r = resolveCanonicalCampaignRoleAuthority({
      request: request(), evidence: [row()], identities: [],
    });
    expect(r.satisfiesRoleAuthority).toBe(false);
    expect(r.blockers).toContain("role_resolver_version_unvalidated");
  });

  it("publishes the rule it enforces", () => {
    expect(CANONICAL_ROLE_AUTHORITY_RULE.requiredConfidence).toBe("high");
    expect(CANONICAL_ROLE_AUTHORITY_RULE.requiresValidatedResolverVersion).toBe(true);
    expect(CANONICAL_ROLE_AUTHORITY_RULE.manualLabelAccepted).toBe(false);
    expect(CANONICAL_ROLE_AUTHORITY_RULE.campaignNameConsulted).toBe(false);
    expect([...CANONICAL_ROLE_AUTHORITY_RULE.requiresExactCompositeScope])
      .toEqual(["businessId", "providerAccountId", "campaignId", "asOfDate"]);
  });
});

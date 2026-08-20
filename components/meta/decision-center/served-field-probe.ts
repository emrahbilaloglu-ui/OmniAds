import { readFileSync } from "node:fs";

import ts from "typescript";

import { META_CAMPAIGN_KINDS } from "@/lib/meta/campaign-label-types";
import { META_OS_DECISIONS_PRESENTATION_VERSION } from "@/lib/meta/decisions-os-contract";
import {
  META_DECISIONS_AD_CANDIDATE_SELECTION_VERSION,
  META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
  META_DECISIONS_SECTION_SELECTION_VERSION,
  META_DECISIONS_WORKSPACE_CONTRACT_VERSION,
  META_DECISION_QUEUE_SECTION_KEYS,
} from "@/lib/meta/decisions-workspace-contract";
import type { MetaDecisionsWorkspacePayload } from "@/components/meta/redesign/types";

/**
 * THE PROBE BEHIND THE SERVED-FIELD COVERAGE MATRIX.
 *
 * The matrix's first version could only prove that every served field had been
 * CLASSIFIED. It could not prove the classification was TRUE: a "RENDERED"
 * entry was checked against a list of surface names, so marking a field
 * rendered at a surface that never reads it passed exactly as loudly as a
 * field that really is on screen. A coverage test that cannot fail certifies
 * the gap it was written to close.
 *
 * WHAT THIS MODULE DOES INSTEAD. It builds the WHOLE Decision payload from the
 * contract source itself — every interface the payload reaches, every leaf
 * populated — and can rebuild it with exactly ONE served leaf changed to a
 * different value, everywhere that leaf occurs. The caller then runs the real
 * adapters on both payloads and compares each surface's serialised output. A
 * field is proven to reach a surface when, and only when, changing it changes
 * what that surface produces. Nothing about that can be satisfied by naming a
 * surface in a string table.
 *
 * WHY THE FIXTURE IS GENERATED AND NOT WRITTEN OUT. A hand-written payload
 * covers the fields its author remembered. This one is walked out of
 * `components/meta/redesign/types.ts`, `lib/meta/decisions-os-contract.ts` and
 * `lib/meta/decisions-workspace-contract.ts` with the TypeScript parser, so a
 * field added to any of them is populated on the next run rather than silently
 * left undefined — an undefined field is unobservable, and an unobservable
 * field would pass an absence check for the wrong reason.
 *
 * WHAT "CHANGED TO A DIFFERENT VALUE" MEANS PER TYPE. A free string gets a
 * unique sentinel token; a date-shaped string gets a different real date, so
 * the formatters that parse it keep working; a number gets a value that still
 * differs after `toFixed(2)`; a boolean is negated; a union of literals moves
 * to its second member. A leaf the contract pins to ONE value (`attribution:
 * "meta_attributed"`, a `typeof CONTRACT_VERSION`) cannot be varied at all —
 * `varies: false` says so, and the matrix proves those a different way rather
 * than pretending a sentinel was possible.
 */

const CONTRACT_FILES = [
  "components/meta/redesign/types.ts",
  "lib/meta/decisions-os-contract.ts",
  "lib/meta/decisions-workspace-contract.ts",
] as const;

/** The one payload the Decision page is handed. Everything walks from here. */
const ROOT = "MetaDecisionsWorkspacePayload";

const BUILTIN_TYPES = new Set([
  "Array",
  "ReadonlyArray",
  "Record",
  "Pick",
  "Omit",
  "Exclude",
  "NonNullable",
  "Partial",
  "Readonly",
]);

/**
 * `typeof X` leaves, resolved to the constant the contract actually exports.
 *
 * Read from the modules rather than retyped here: a version bump that changed
 * only this table would make the fixture disagree with the payload the server
 * sends, which is the one thing a fixture must never do.
 */
const TYPEOF_CONSTANTS: Record<string, string> = {
  META_OS_DECISIONS_PRESENTATION_VERSION,
  META_DECISIONS_WORKSPACE_CONTRACT_VERSION,
  META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
  META_DECISIONS_SECTION_SELECTION_VERSION,
  META_DECISIONS_AD_CANDIDATE_SELECTION_VERSION,
};

/**
 * `(typeof CONST_ARRAY)[number]` leaves. The AST cannot evaluate the array, so
 * the array itself is imported and its members are the literal domain.
 */
const CONSTANT_ARRAYS: Record<string, readonly string[]> = {
  META_DECISION_QUEUE_SECTION_KEYS,
  META_CAMPAIGN_KINDS,
};

/**
 * Closed value sets the walk cannot read, because the type lives in a file the
 * walk does not open. Both are single-purpose tokens the Decision surfaces
 * branch on, so inventing a value would take a branch the product never takes.
 */
const EXTERNAL_LITERALS: Record<string, readonly string[]> = {
  MetaCampaignKind: META_CAMPAIGN_KINDS,
  BriefingStatusFilter: ["active", "active_plus_recent_paused", "all"],
};

export interface ServedField {
  readonly key: string;
  readonly iface: string;
  /** False when the contract pins the leaf to a single value. */
  readonly varies: boolean;
  /** The pinned value's text, for the leaves that cannot vary. */
  readonly constantText: string | null;
}

interface LeafSpec {
  readonly base: unknown;
  readonly alt: unknown;
  readonly varies: boolean;
  readonly constantText: string | null;
}

interface Contracts {
  readonly declarations: Map<string, ts.InterfaceDeclaration>;
  readonly aliases: Map<string, ts.TypeAliasDeclaration>;
}

let contractCache: Contracts | null = null;

function contracts(): Contracts {
  if (contractCache) return contractCache;
  const declarations = new Map<string, ts.InterfaceDeclaration>();
  const aliases = new Map<string, ts.TypeAliasDeclaration>();
  for (const file of CONTRACT_FILES) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement)) {
        declarations.set(statement.name.text, statement);
      }
      if (ts.isTypeAliasDeclaration(statement)) {
        aliases.set(statement.name.text, statement);
      }
    }
  }
  contractCache = { declarations, aliases };
  return contractCache;
}

function referencedTypes(node: ts.TypeNode): Set<string> {
  const found = new Set<string>();
  const walk = (child: ts.Node) => {
    if (ts.isTypeReferenceNode(child)) found.add(child.typeName.getText());
    ts.forEachChild(child, walk);
  };
  walk(node);
  return found;
}

function hasInlineObject(node: ts.TypeNode): boolean {
  let found = false;
  const walk = (child: ts.Node) => {
    if (ts.isTypeLiteralNode(child)) found = true;
    ts.forEachChild(child, walk);
  };
  walk(node);
  return found;
}

/* ------------------------------------------------------------------ *
 * Literal domains
 * ------------------------------------------------------------------ */

/**
 * Every value a leaf's type admits, when the type is a closed set of literals.
 *
 * Returns null for open types (`string`, `number`, arrays), which are handled
 * by the sentinel path instead. Aliases, `Exclude<>` and `(typeof A)[number]`
 * are followed, because the contract states half its enumerations that way and
 * a probe that stopped at the alias would have to invent a value the contract
 * does not admit.
 */
function literalDomain(type: ts.TypeNode, depth = 0): unknown[] | null {
  if (depth > 8) return null;
  if (ts.isParenthesizedTypeNode(type)) return literalDomain(type.type, depth + 1);
  if (ts.isLiteralTypeNode(type)) {
    const literal = type.literal;
    if (ts.isStringLiteral(literal)) return [literal.text];
    if (ts.isNumericLiteral(literal)) return [Number(literal.text)];
    if (literal.kind === ts.SyntaxKind.NullKeyword) return [null];
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return [true];
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return [false];
    return null;
  }
  if (ts.isUnionTypeNode(type)) {
    const values: unknown[] = [];
    for (const member of type.types) {
      const domain = literalDomain(member, depth + 1);
      if (!domain) return null;
      values.push(...domain);
    }
    return values;
  }
  if (ts.isTypeOperatorNode(type)) return null;
  if (ts.isIndexedAccessTypeNode(type)) {
    // `(typeof CONST_ARRAY)[number]`
    let object: ts.TypeNode = type.objectType;
    while (ts.isParenthesizedTypeNode(object)) object = object.type;
    if (
      ts.isTypeQueryNode(object) &&
      CONSTANT_ARRAYS[object.exprName.getText()]
    ) {
      return [...CONSTANT_ARRAYS[object.exprName.getText()]!];
    }
    // `SomeInterface["member"]` — resolved against the declared member.
    const { declarations } = contracts();
    if (ts.isTypeReferenceNode(object)) {
      const declaration = declarations.get(object.typeName.getText());
      const index = type.indexType;
      if (declaration && ts.isLiteralTypeNode(index) && ts.isStringLiteral(index.literal)) {
        const member = declaration.members.find(
          (candidate) =>
            ts.isPropertySignature(candidate) &&
            candidate.name?.getText() === index.literal.getText().slice(1, -1),
        );
        if (member && ts.isPropertySignature(member) && member.type) {
          return literalDomain(member.type, depth + 1);
        }
      }
    }
    return null;
  }
  if (ts.isTypeQueryNode(type)) {
    const constant = TYPEOF_CONSTANTS[type.exprName.getText()];
    return constant === undefined ? null : [constant];
  }
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText();
    const { aliases } = contracts();
    if (name === "Exclude") {
      const [source, removed] = type.typeArguments ?? [];
      if (!source || !removed) return null;
      const domain = literalDomain(source, depth + 1);
      const excluded = literalDomain(removed, depth + 1);
      if (!domain || !excluded) return null;
      return domain.filter((value) => !excluded.includes(value));
    }
    const alias = aliases.get(name);
    if (alias) return literalDomain(alias.type, depth + 1);
    const external = EXTERNAL_LITERALS[name];
    if (external) return [...external];
    return null;
  }
  if (type.kind === ts.SyntaxKind.NullKeyword) return [null];
  return null;
}

/** The keyword types a leaf can reduce to once nulls are set aside. */
type OpenKind = "string" | "number" | "boolean" | "string[]" | "number[]" | null;

function openKind(type: ts.TypeNode, depth = 0): OpenKind {
  if (depth > 8) return null;
  if (ts.isParenthesizedTypeNode(type)) return openKind(type.type, depth + 1);
  if (ts.isUnionTypeNode(type)) {
    for (const member of type.types) {
      const kind = openKind(member, depth + 1);
      if (kind) return kind;
    }
    return null;
  }
  if (ts.isArrayTypeNode(type)) {
    const element = openKind(type.elementType, depth + 1);
    if (element === "string") return "string[]";
    if (element === "number") return "number[]";
    return null;
  }
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText();
    const [first] = type.typeArguments ?? [];
    if ((name === "Array" || name === "ReadonlyArray") && first) {
      const element = openKind(first, depth + 1);
      if (element === "string") return "string[]";
      if (element === "number") return "number[]";
      return null;
    }
    const alias = contracts().aliases.get(name);
    if (alias) return openKind(alias.type, depth + 1);
    return null;
  }
  if (type.kind === ts.SyntaxKind.StringKeyword) return "string";
  if (type.kind === ts.SyntaxKind.NumberKeyword) return "number";
  if (type.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  return null;
}

/* ------------------------------------------------------------------ *
 * Sentinels
 * ------------------------------------------------------------------ */

/**
 * Leaf names whose string value is parsed as a date somewhere downstream.
 *
 * A sentinel token in these produces "Invalid Date" for BOTH the base and the
 * probe payload, and two identical invalid outputs would read as "this field
 * reaches nothing". Real, different dates keep the formatters honest.
 */
const DATE_ONLY = /(Date|AsOf)$/;
const TIMESTAMP =
  /(At|Cutoff|LastRun)$/;

function isDateLeaf(key: string): boolean {
  const name = key.split(".").pop() ?? "";
  return DATE_ONLY.test(name) || TIMESTAMP.test(name);
}

function isDateOnlyLeaf(key: string): boolean {
  const name = key.split(".").pop() ?? "";
  return DATE_ONLY.test(name);
}

/**
 * Leaves whose value must survive a currency-code check.
 *
 * `formatMoney` returns an em dash for anything that is not three letters, so
 * a sentinel here would erase every money string on the screen and make the
 * amounts beside it look unrendered.
 */
function isCurrencyLeaf(key: string): boolean {
  return (key.split(".").pop() ?? "") === "currency";
}

/**
 * Leaves that carry a PROVIDER STATUS, typed as an open string because Meta's
 * vocabulary is not ours to close.
 *
 * The surfaces branch on the exact word — `isExactActiveMetaDecisionDeliveryScope`
 * demands "ACTIVE" at every level, the Archive row tones on "PAUSED" — so a
 * sentinel would take neither branch and prove nothing about either.
 */
const STATUS_LEAVES = new Set([
  "status",
  "campaignStatus",
  "adsetStatus",
  "adStatus",
]);

function isStatusLeaf(key: string): boolean {
  return STATUS_LEAVES.has(key.split(".").pop() ?? "");
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Values for leaves the generic rules cannot serve.
 *
 * Two reasons appear here and no others: the leaf's type lives outside the
 * walked contracts (so the parser has nothing to enumerate), or the leaf is a
 * JOIN KEY whose two spellings must agree for the payload to describe one
 * account rather than several unrelated ones.
 */
const OVERRIDES: Record<string, { base: unknown; alt: unknown }> = {
  // The banner action is accepted only for internal hrefs. Generic string
  // sentinels are intentionally rejected by the production helper, so use two
  // real internal destinations to prove that the served href reaches the CTA.
  "MetaDecisionsWorkspaceBanner.action.href": {
    base: "/commercial-truth",
    alt: "/platforms/meta/history",
  },
  // Join: the OS ad decision and its canonical envelope are one row.
  "MetaOsAdDecision.decisionId": { base: "mdd_probe_1", alt: "mdd_probe_alt" },
  "MetaCanonicalDecision.decisionId": { base: "mdd_probe_1", alt: "mdd_probe_alt" },
  "MetaOsAdDecision.sourceSnapshotId": { base: "snap_probe_1", alt: "snap_probe_alt" },
  "MetaCanonicalDecision.sourceSnapshotId": {
    base: "snap_probe_1",
    alt: "snap_probe_alt",
  },
  // Join: the structure node describes the recommendation the lane serves.
  "MetaOsStructureNode.sourceRecommendationId": {
    base: "rec_probe_action",
    alt: "rec_probe_action_alt",
  },
  // Join: the healthy rows and the inventory rows group under one campaign.
  "MetaHealthyEntity.campaignId": { base: "cmp_probe", alt: "cmp_probe_alt" },
  "MetaStructureInventoryEntity.campaignId": {
    base: "cmp_probe",
    alt: "cmp_probe_alt",
  },
  // Outside the walked contracts: the lane rows themselves.
  "MetaLanePayload.actionNow": {
    base: [probeRecommendation("rec_probe_action", "Probe action row")],
    alt: [probeRecommendation("rec_probe_action_alt", "Probe action row alt")],
  },
  "MetaLanePayload.watching": {
    base: [probeRecommendation("rec_probe_watch", "Probe watching row")],
    alt: [probeRecommendation("rec_probe_watch_alt", "Probe watching row alt")],
  },
  "MetaLanePayload.nonSales": {
    base: [probeRecommendation("rec_probe_nonsales", "Probe non-sales row")],
    alt: [
      probeRecommendation("rec_probe_nonsales_alt", "Probe non-sales row alt"),
    ],
  },
  // Outside the walked contracts: the served status filter and campaign role.
  "MetaDecisionsWorkspacePayload.statusFilter": { base: "active", alt: "all" },
  "MetaPulsePayload.statusFilter": { base: "active", alt: "all" },
  "MetaLanePayload.statusFilter": { base: "active", alt: "all" },
  "MetaStructureInventoryEntity.entityConfiguration": {
    base: probeEntityConfiguration("lowest_cost", "Lowest Cost", 1_000_000),
    alt: probeEntityConfiguration("cost_cap", "Cost Cap", 4_400_000),
  },
  /*
   * The engine's verdict vocabulary. Typed `string` because the engine owns the
   * words, but `decisionTone` and the posture band's refresh count both branch
   * on them, so a sentinel token would render as the same neutral nothing at
   * both ends of the probe. "scale" and "refresh" are two verdicts this account
   * could really be served, and they differ in tone AND in the refresh tally.
   */
  "MetaOsAdDecision.publishedLabel": { base: "scale", alt: "refresh" },
  "MetaOsAdDecision.rawLabel": { base: "scale", alt: "refresh" },
  "MetaOsDecisionAuthorityProvenance.publishedLabel": { base: "scale", alt: "refresh" },
  "MetaOsDecisionAuthorityProvenance.preAuthorityLabel": { base: "scale", alt: "refresh" },
  "MetaOsDecisionAuthorityProvenance.postAuthorityRawLabel": { base: "scale", alt: "refresh" },
  "MetaCanonicalDecision.sourceDecision.label": { base: "scale", alt: "refresh" },
  "MetaCanonicalDecision.sourceDecision.preAuthorityLabel": { base: "scale", alt: "refresh" },
  "MetaCanonicalDecision.sourceDecision.rawLabel": { base: "scale", alt: "refresh" },
  "MetaCanonicalDecision.classification.buyerLabel": { base: "scale", alt: "refresh" },
  "MetaArchivedEntity.advisory.decisionLabel": { base: "scale", alt: "refresh" },
  /*
   * `image | video | catalog` and `none | watch | fatigued | unknown`: closed
   * vocabularies the contract states in prose rather than in the type, and the
   * only values the thumb's three-letter kind and the fatigued-spend share can
   * read. Anything else renders as an em dash at BOTH ends of the probe.
   */
  "MetaOsAdDecision.creativeFormat": { base: "video", alt: "image" },
  "MetaCanonicalDecision.creativeFormat": { base: "video", alt: "image" },
  "MetaOsAdDecision.fatigueStatus": { base: "fatigued", alt: "none" },
  "MetaCanonicalDecision.fatigueStatus": { base: "fatigued", alt: "none" },
  /*
   * The intent tone map reads `launchpad`, `brief`, `manual` and `review`; the
   * contract's first and last members (`execute`, `none`) are both neutral, so
   * moving between them would leave the button looking identical.
   */
  "MetaOsDecisionAction.intent": { base: "execute", alt: "launchpad" },
  /*
   * `actionTone` reads the provider mutation FIRST, so a probe that left one
   * pinned there would tone every button identically and hide the intent it is
   * supposed to be proving. Null is the served value for a review-only action —
   * the state most rows on a real account are actually in.
   */
  "MetaOsDecisionAction.providerMutation": { base: null, alt: "pause" },
  /*
   * The two review-only reasons the Archive note actually branches on. Any
   * other string produces no headline at either end of the probe.
   */
  "MetaDecisionSourceAuthority.reviewOnlyReason": {
    base: "current_hierarchy_is_not_active",
    alt: "current_hierarchy_status_is_unknown",
  },
};

function probeRecommendation(id: string, title: string): unknown {
  return {
    id,
    entityType: "campaign",
    entityId: `${id}_entity`,
    entityName: title,
    campaignId: "cmp_probe",
    campaignName: "Probe campaign",
    campaignKind: "main",
    title,
    action: "pause",
    actionLabel: "Pause",
    priority: 1,
    urgency: "high",
    confidence: "high",
    why: `${title} why`,
    expectedImpact: `${title} impact`,
    status: "ACTIVE",
    metrics: { spend: 1234.5, roas: 2.5, cpa: 12.5, purchases: 9 },
    evidence: [],
  };
}

function probeEntityConfiguration(
  bidStrategyType: string,
  bidStrategyLabel: string,
  dailyBudget: number,
): unknown {
  return {
    source: "account_scoped_campaign_row",
    budgetOwner: "campaign",
    budgetMode: "campaign_budget",
    controlOwner: "campaign",
    status: "ACTIVE",
    optimizationGoal: "Offsite Conversions",
    bidStrategyType,
    bidStrategyLabel,
    dailyBudget,
    lifetimeBudget: null,
    budgetUtilization: null,
  };
}

/**
 * `Record<ClosedKeySet, number>` leaves — a tally per lane, not a shape.
 *
 * Kept a leaf rather than a container because the contract states the keys, so
 * there is nothing under it for the matrix to classify separately.
 */
function recordOfPrimitiveSpec(type: ts.TypeNode): LeafSpec | null {
  if (!ts.isTypeReferenceNode(type)) return null;
  if (type.typeName.getText() !== "Record") return null;
  const [keyType, valueType] = type.typeArguments ?? [];
  if (!keyType || !valueType) return null;
  const keys = literalDomain(keyType);
  if (!keys) return null;
  const kind = openKind(valueType);
  if (kind !== "number" && kind !== "string") return null;
  const base: Record<string, unknown> = {};
  const alt: Record<string, unknown> = {};
  keys.forEach((key, position) => {
    base[String(key)] = kind === "number" ? 10 + position : `sfp-base-${key}`;
    alt[String(key)] = kind === "number" ? 7_000 + position : `sfp-alt-${key}`;
  });
  return { base, alt, varies: true, constantText: null };
}

const specCache = new Map<string, LeafSpec>();
let sentinelCounter = 0;

function leafSpec(key: string, type: ts.TypeNode): LeafSpec {
  const cached = specCache.get(key);
  if (cached) return cached;
  const spec = computeLeafSpec(key, type);
  specCache.set(key, spec);
  return spec;
}

function computeLeafSpec(key: string, type: ts.TypeNode): LeafSpec {
  const override = OVERRIDES[key];
  if (override) {
    return { base: override.base, alt: override.alt, varies: true, constantText: null };
  }

  const domain = literalDomain(type);
  if (domain) {
    const distinct = domain.filter(
      (value, index) => domain.indexOf(value) === index,
    );
    const usable = distinct.filter((value) => value !== null);
    const pool = usable.length > 0 ? usable : distinct;
    if (pool.length >= 2) {
      // The LAST member, not the second: the contracts order these from the
      // healthy value to the degraded one, and a probe that moved one notch
      // could land on a value the surface renders identically.
      return {
        base: pool[0],
        alt: pool[pool.length - 1],
        varies: true,
        constantText: null,
      };
    }
    const only = pool[0] ?? null;
    return {
      base: only,
      alt: only,
      varies: false,
      constantText: typeof only === "string" ? only : null,
    };
  }

  const recordSpec = recordOfPrimitiveSpec(type);
  if (recordSpec) return recordSpec;

  const index = ++sentinelCounter;
  switch (openKind(type)) {
    case "string": {
      if (isCurrencyLeaf(key)) {
        return { base: "USD", alt: "EUR", varies: true, constantText: null };
      }
      if (isStatusLeaf(key)) {
        return { base: "ACTIVE", alt: "PAUSED", varies: true, constantText: null };
      }
      if (isDateLeaf(key)) {
        const day = 1 + (index % 27);
        const minute = index % 59;
        return isDateOnlyLeaf(key)
          ? {
              base: `2026-03-${pad(day, 2)}`,
              alt: `2025-09-${pad(day, 2)}`,
              varies: true,
              constantText: null,
            }
          : {
              base: `2026-03-${pad(day, 2)}T07:${pad(minute, 2)}:00.000Z`,
              alt: `2025-09-${pad(day, 2)}T19:${pad(minute, 2)}:00.000Z`,
              varies: true,
              constantText: null,
            };
      }
      return {
        base: `sfp-base-${index}`,
        alt: `sfp-alt-${index}`,
        varies: true,
        constantText: null,
      };
    }
    case "number":
      /*
       * A measured zero, not another large number. Zero is the value the
       * surfaces branch on — "print the ROAS only against spend", "show the
       * chip only when the count is non-zero" — so probing with it crosses the
       * gates a second large number would sail straight past, while still
       * printing differently from the base wherever the number is shown.
       */
      return { base: 100 + index + 0.25, alt: 0, varies: true, constantText: null };
    case "boolean":
      return { base: true, alt: false, varies: true, constantText: null };
    case "string[]":
      // Empty, for the same reason a number probes with zero: a list's length
      // is what most of these surfaces read.
      return {
        base: [`sfp-base-${index}-a`, `sfp-base-${index}-b`],
        alt: [],
        varies: true,
        constantText: null,
      };
    case "number[]":
      return { base: [1 + index, 2 + index, 3 + index], alt: [], varies: true, constantText: null };
    default:
      throw new Error(
        `served-field-probe: no value rule for ${key} (${type.getText()})`,
      );
  }
}

/* ------------------------------------------------------------------ *
 * The walk that both enumerates leaves and builds the payload
 * ------------------------------------------------------------------ */

interface WalkState {
  readonly mutate: string | null;
  readonly erase: ReadonlySet<string>;
  readonly force: ReadonlyMap<string, unknown>;
  readonly fields: Map<string, ServedField>;
  readonly externals: Set<string>;
  depth: number;
}

/**
 * The value a leaf takes in one build.
 *
 * The mutation wins over everything: a scenario that erased or pinned the very
 * field under test would prove nothing about it. That ordering is what lets a
 * scenario erase a whole fallback chain and still give each member of the chain
 * its own turn — every other spelling is silenced, the one being probed is not.
 */
function leafValueFor(key: string, spec: LeafSpec, state: WalkState): unknown {
  if (state.mutate === key) return spec.alt;
  if (state.force.has(key)) return state.force.get(key);
  if (state.erase.has(key)) return null;
  return spec.base;
}

function recordLeaf(state: WalkState, key: string, iface: string, spec: LeafSpec) {
  if (state.fields.has(key)) return;
  state.fields.set(key, {
    key,
    iface,
    varies: spec.varies,
    constantText: spec.constantText,
  });
}

function interfaceValue(name: string, state: WalkState): unknown {
  const { declarations } = contracts();
  const declaration = declarations.get(name);
  if (!declaration) return null;
  if (state.depth > 24) return null;
  state.depth += 1;
  const value = memberValues(name, declaration.members, "", state);
  state.depth -= 1;
  return value;
}

function memberValues(
  iface: string,
  members: ts.NodeArray<ts.TypeElement>,
  prefix: string,
  state: WalkState,
): Record<string, unknown> {
  const { declarations, aliases } = contracts();
  const output: Record<string, unknown> = {};
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name || !member.type) continue;
    const name = member.name.getText();
    const path = prefix ? `${prefix}.${name}` : name;
    const key = `${iface}.${path}`;
    let container = hasInlineObject(member.type);
    for (const reference of referencedTypes(member.type)) {
      if (declarations.has(reference)) {
        container = true;
      } else if (!aliases.has(reference) && !BUILTIN_TYPES.has(reference)) {
        state.externals.add(reference);
      }
    }
    if (!container) {
      const spec = leafSpec(key, member.type);
      recordLeaf(state, key, iface, spec);
      output[name] = leafValueFor(key, spec, state);
      continue;
    }
    output[name] = containerValue(iface, member.type, path, state);
  }
  return output;
}

/**
 * The value for a member whose type reaches another contract shape.
 *
 * Mirrors the leaf walk's `descend`, so the paths the matrix keys on and the
 * paths the fixture populates are the same paths. Where the two could drift,
 * the matrix's own "classifies every served field" assertion catches it.
 */
function containerValue(
  iface: string,
  type: ts.TypeNode,
  path: string,
  state: WalkState,
): unknown {
  if (state.depth > 24) return null;
  if (ts.isParenthesizedTypeNode(type)) {
    return containerValue(iface, type.type, path, state);
  }
  if (ts.isTypeLiteralNode(type)) {
    return memberValues(iface, type.members, path, state);
  }
  if (ts.isArrayTypeNode(type)) {
    return [containerValue(iface, type.elementType, `${path}[]`, state)];
  }
  if (ts.isUnionTypeNode(type)) {
    // Every union in these contracts is `T | null`; the probe serves T, so the
    // fields inside T are populated and therefore observable.
    for (const member of type.types) {
      if (
        member.kind === ts.SyntaxKind.NullKeyword ||
        member.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isLiteralTypeNode(member) &&
          member.literal.kind === ts.SyntaxKind.NullKeyword)
      ) {
        continue;
      }
      return containerValue(iface, member, path, state);
    }
    return null;
  }
  if (ts.isIndexedAccessTypeNode(type)) {
    const { declarations } = contracts();
    const object = type.objectType;
    const index = type.indexType;
    if (
      ts.isTypeReferenceNode(object) &&
      ts.isLiteralTypeNode(index) &&
      ts.isStringLiteral(index.literal)
    ) {
      const member = index.literal.text;
      const declaration = declarations.get(object.typeName.getText());
      const target = declaration?.members.find(
        (candidate) =>
          ts.isPropertySignature(candidate) &&
          candidate.name?.getText() === member,
      );
      if (target && ts.isPropertySignature(target) && target.type) {
        // The referenced interface owns the classification of these leaves, so
        // the value is built under THAT interface's key space.
        const owner = object.typeName.getText();
        const key = `${owner}.${member}`;
        const reachesContract = [...referencedTypes(target.type)].some(
          (reference) => declarations.has(reference),
        );
        if (!hasInlineObject(target.type) && !reachesContract) {
          return leafValueFor(key, leafSpec(key, target.type), state);
        }
        return containerValue(owner, target.type, member, state);
      }
    }
    return null;
  }
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText();
    const [first, second] = type.typeArguments ?? [];
    if ((name === "Array" || name === "ReadonlyArray") && first) {
      return [containerValue(iface, first, `${path}[]`, state)];
    }
    if (
      (name === "NonNullable" ||
        name === "Readonly" ||
        name === "Partial" ||
        name === "Required") &&
      first
    ) {
      return containerValue(iface, first, path, state);
    }
    if (name === "Record" && second) {
      const keys = literalDomain(first!) ?? [];
      const record: Record<string, unknown> = {};
      for (const recordKey of keys) {
        record[String(recordKey)] = containerValue(
          iface,
          second,
          `${path}{}`,
          state,
        );
      }
      return record;
    }
    if (contracts().declarations.has(name)) return interfaceValue(name, state);
  }
  /*
   * A member the walk classified as a container because its type MENTIONS a
   * contract interface, but which resolves to a plain value — an indexed access
   * such as `MetaOsAdDecision["campaignRoleSource"]`. It is not a new leaf (the
   * interface it points at already owns that key), so nothing is recorded; the
   * value is taken from that key's spec so a mutation of it travels here too.
   */
  const key = `${iface}.${path}`;
  try {
    return leafValueFor(key, leafSpec(key, type), state);
  } catch {
    return null;
  }
}

export interface ProbeWalk {
  readonly fields: readonly ServedField[];
  readonly externals: ReadonlySet<string>;
}

/**
 * One account shape to probe against.
 *
 * A single "everything present" payload cannot prove a FALLBACK: the field that
 * only speaks when the preferred spelling is absent stays silent, and its
 * RENDERED claim would look false. A scenario silences the shadowing fields
 * (`erase`), pins a served state the surface branches on (`force`), or empties a
 * served collection (`empty`, by payload path, for the envelopes an account can
 * genuinely arrive without). Each is a real state of a real account, not a
 * fixture convenience.
 */
export interface ProbeScenario {
  readonly name: string;
  readonly erase?: readonly string[];
  readonly force?: Readonly<Record<string, unknown>>;
  readonly empty?: readonly string[];
}

function emptyAtPath(payload: unknown, path: string): void {
  const segments = path.split(".");
  const last = segments.pop()!;
  let node: Record<string, unknown> | undefined = payload as Record<string, unknown>;
  for (const segment of segments) {
    if (!node || typeof node !== "object") return;
    node = node[segment] as Record<string, unknown> | undefined;
  }
  if (!node || typeof node !== "object") return;
  const target = node[last];
  if (Array.isArray(target)) node[last] = [];
  else if (target && typeof target === "object") node[last] = {};
}

function walk(
  mutate: string | null,
  scenario?: ProbeScenario,
): { payload: MetaDecisionsWorkspacePayload; state: WalkState } {
  const state: WalkState = {
    mutate,
    erase: new Set(scenario?.erase ?? []),
    force: new Map(Object.entries(scenario?.force ?? {})),
    fields: new Map(),
    externals: new Set(),
    depth: 0,
  };
  const payload = interfaceValue(ROOT, state) as MetaDecisionsWorkspacePayload;
  for (const path of scenario?.empty ?? []) {
    if (path === mutate) continue;
    emptyAtPath(payload, path);
  }
  return { payload, state };
}

/** Every served leaf the Decision payload can carry, and the foreign contracts it reaches. */
export function servedFieldWalk(): ProbeWalk {
  const { state } = walk(null);
  return { fields: [...state.fields.values()], externals: state.externals };
}

/**
 * The whole payload, every leaf populated.
 *
 * `mutate` names ONE served leaf by its matrix key; that leaf takes its
 * alternate value at every position it occupies in the payload, and nothing
 * else changes. Passing null builds the scenario's baseline.
 */
export function buildProbePayload(
  mutate: string | null = null,
  scenario?: ProbeScenario,
): MetaDecisionsWorkspacePayload {
  return walk(mutate, scenario).payload;
}

/**
 * The single semantic surface registry for Meta and its sub-surfaces.
 *
 * Rank 5 of the authority order in
 * `docs/meta-market-ready-master-plan-2026-08-22.md` §3, and the answer to its
 * WP2. Before this file, five separate tables each held a partial opinion about
 * the same surfaces — `components/layout/nav-items.ts` (rail rows and active
 * hrefs), `lib/dashboard-v2/screen-registry.ts` (screen ids and `/app`
 * spellings), `lib/zero-base/compatibility.ts` (legacy destinations),
 * `components/layout/dashboard-frame.tsx` (route-owned surfaces) and the route
 * files themselves (what actually mounts). Nothing forced them to agree, and
 * they did not:
 *
 * - `/c/:id/meta/history` resolved to no screen at all, so the rail lit up
 *   *Decisions* while the operator was reading History;
 * - `/c/:id/meta/intelligence` lit up nothing, on a route that has existed and
 *   worked all along;
 * - `/platforms/meta/audiences` had two canonical destinations depending on
 *   which table you asked.
 *
 * This registry states each fact once. It is **descriptive, not executable**:
 * it grants nothing, authorizes nothing and mounts nothing. Its value is that
 * `surface-registry.contract.test.ts` reads it and the five tables above
 * together and fails when any of them drifts — including when a `mountedBody`
 * names a file that does not exist, which is how a "ported" surface that
 * nobody routed gets caught.
 *
 * ## Capability vocabulary
 *
 * `windowCapability` implements §8.1–8.2: it decides whether the topbar date
 * picker applies to a surface at all, so a control-state screen stops showing
 * an active range it never uses.
 *
 * `providerAccountCapability` implements D6: `single_physical` surfaces serve
 * no data without exactly one resolved physical Meta account, and `null` means
 * "not selected" — never "all accounts".
 */
import type { PlanId } from "@/lib/pricing/plans";

/** §8.1. Which clock a surface answers on, and therefore whether the topbar picker applies. */
export type SurfaceWindowCapability =
  /** Metrics measured over the selected reporting range. Picker applies. */
  | "metric_window"
  /** Events that happened inside the selected range. Picker applies. */
  | "event_window"
  /** What is true right now. Picker does NOT apply and says so. */
  | "current_state"
  /** The surface owns a fixed evidence window; the global picker does not drive it. */
  | "fixed_evidence"
  /** Several clocks at once; the picker drives only the part it owns. */
  | "mixed";

/** D6. How much account scope a surface needs before it may serve anything. */
export type SurfaceAccountCapability =
  /** Exactly one physical Meta account, or the surface refuses. */
  | "single_physical"
  /** Business-wide; an account may narrow it but is not required. */
  | "business_scope"
  /** A public token carries its own frozen scope. No session account. */
  | "token_public"
  /** Assignment management itself — it decides accounts rather than using one. */
  | "assignment";

/** What a surface may do to the provider, as shipped. */
export type SurfaceActionCapability =
  | "read_only"
  /** Internal state changes only (workflow, briefs, shares). No provider write. */
  | "internal_write"
  /** Provider writes exist and are gated; see `gate`. */
  | "gated_provider_write"
  /** Connection and assignment writes. */
  | "assignment_write";

export interface MetaSurface {
  /** Stable id. Never a route, so a route can move without breaking references. */
  readonly surfaceId: string;
  readonly label: string;
  /** `hub` owns a rail row; `tab` sits inside a hub; `sub` is reachable but unrailed. */
  readonly role: "hub" | "tab" | "sub" | "public";
  /** The business-scoped route of record. */
  readonly canonicalRoute: string;
  /** Session-scoped `/app/**` spellings that resolve to the same body. */
  readonly aliases: readonly string[];
  /** Pre-v2 `/platforms/**` spellings that must still resolve. */
  readonly legacyRedirect: readonly string[];
  /** The file that owns the pixels. Asserted to exist by the contract test. */
  readonly mountedBody: string;
  readonly providerAccountCapability: SurfaceAccountCapability;
  readonly windowCapability: SurfaceWindowCapability;
  readonly actionCapability: SurfaceActionCapability;
  /** The release gate that must be open before the action capability is offered. */
  readonly gate?: string;
  readonly requiredPlan?: PlanId;
  /** Every path that should light this surface's rail row. */
  readonly activeHrefs: readonly string[];
  /** Position in the Meta rail group, or `null` for surfaces with no row. */
  readonly railOrder: number | null;
  /** The hub a `tab` or `sub` belongs to. */
  readonly parentSurfaceId?: string;
}

/**
 * Meta surfaces, their tabs, and the sub-surfaces that hang off them.
 *
 * Account Intelligence remains addressable while its route is completed, but
 * is not advertised in the primary rail as an unavailable destination.
 */
export const META_SURFACES: readonly MetaSurface[] = [
  {
    surfaceId: "meta-decisions",
    label: "Decisions",
    role: "hub",
    canonicalRoute: "/c/[businessId]/meta/decisions",
    aliases: ["/app/meta/decisions"],
    // `/platforms/meta` only. `/platforms/meta/decisions` looks like a legacy
    // spelling and is not one: no route directory serves it, the vendored
    // contract has no record of it, and nothing links to it. It was a phantom
    // row in `APP_PATH_BY_LEGACY_PATH` that translated to a 404, and it is
    // removed there rather than honoured here.
    legacyRedirect: ["/platforms/meta"],
    mountedBody: "components/meta/redesign/MetaPlatformPage.tsx",
    providerAccountCapability: "single_physical",
    // §8.1 "mixed": the metric window and the decision as-of date are separate
    // clocks (D7), and conflating them is what D070 had to correct in the
    // resolver. The picker drives the first and never the second.
    windowCapability: "mixed",
    actionCapability: "gated_provider_write",
    gate: "META_DECISION_WORKFLOW_UI",
    // History is deliberately ABSENT here. It used to be listed, so reading
    // History lit up Decisions — the plan's §5.1 finding 4. History owns a row
    // of its own now, and a row cannot be active for a surface it does not own.
    activeHrefs: [],
    railOrder: 1,
  },
  {
    surfaceId: "meta-intelligence",
    label: "Account Intelligence",
    role: "hub",
    canonicalRoute: "/c/[businessId]/meta/intelligence",
    aliases: ["/app/meta/intelligence"],
    // No legacy spelling. `/platforms/meta/audiences` is NOT it: that path
    // belongs to Creative Studio Audiences (ADR-004), even though the vendored
    // `generated-contracts.ts` still records it as merged into this leaf.
    legacyRedirect: [],
    mountedBody: "components/zero-base/meta/intelligence/intelligence-view.tsx",
    providerAccountCapability: "single_physical",
    // §8.1 "mixed": nine sections, each carrying its own evidence window.
    windowCapability: "mixed",
    actionCapability: "internal_write",
    activeHrefs: [],
    railOrder: null,
  },
  {
    surfaceId: "creative-studio",
    label: "Creative Studio",
    role: "hub",
    canonicalRoute: "/c/[businessId]/creative/performance",
    aliases: ["/app/creative/performance"],
    legacyRedirect: ["/platforms/meta/creatives"],
    mountedBody: "components/creatives/CreativeStudioExact.tsx",
    providerAccountCapability: "single_physical",
    windowCapability: "metric_window",
    actionCapability: "read_only",
    activeHrefs: [
      "/c/[businessId]/creative/copies",
      "/c/[businessId]/creative/landing-pages",
      "/c/[businessId]/creative/inbox",
      "/c/[businessId]/creative/audiences",
      "/c/[businessId]/creative/briefs",
      "/c/[businessId]/creative/shares",
    ],
    railOrder: 2,
  },
  {
    surfaceId: "meta-launchpad",
    label: "Launchpad",
    role: "hub",
    canonicalRoute: "/c/[businessId]/meta/launchpad",
    aliases: ["/app/meta/launchpad"],
    legacyRedirect: ["/platforms/meta/launchpad"],
    mountedBody: "app/(dashboard)/platforms/meta/launchpad/legacy-page.tsx",
    providerAccountCapability: "single_physical",
    // Candidate evidence uses Launchpad's fixed, labelled eligibility window.
    // The global reporting picker is not read anywhere on this route.
    windowCapability: "fixed_evidence",
    actionCapability: "gated_provider_write",
    gate: "META_LAUNCHPAD_EXECUTION",
    activeHrefs: [],
    railOrder: 3,
  },
  {
    surfaceId: "meta-automation",
    label: "Automation",
    role: "hub",
    canonicalRoute: "/c/[businessId]/meta/automation",
    aliases: ["/app/meta/automation"],
    legacyRedirect: ["/platforms/meta/automation"],
    mountedBody:
      "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
    providerAccountCapability: "single_physical",
    // Control state, not a reporting range. The picker is annotated inactive
    // here rather than left looking live over data it cannot re-scope (§8.2).
    windowCapability: "current_state",
    actionCapability: "gated_provider_write",
    gate: "META_AUTOMATION_STOP_UI",
    activeHrefs: [],
    railOrder: 4,
  },
  {
    surfaceId: "meta-history",
    label: "History",
    role: "hub",
    canonicalRoute: "/c/[businessId]/meta/history",
    aliases: ["/app/meta/history"],
    legacyRedirect: ["/platforms/meta/history"],
    mountedBody: "components/zero-base/meta/history/history-view.tsx",
    providerAccountCapability: "single_physical",
    windowCapability: "event_window",
    actionCapability: "read_only",
    activeHrefs: [],
    railOrder: 5,
  },

  // ---- Creative Studio tabs -------------------------------------------------
  {
    surfaceId: "creative-copies",
    label: "Copies",
    role: "tab",
    parentSurfaceId: "creative-studio",
    canonicalRoute: "/c/[businessId]/creative/copies",
    aliases: ["/app/creative/copies"],
    legacyRedirect: ["/platforms/meta/copies"],
    mountedBody: "components/creatives/CreativeStudioExact.tsx",
    providerAccountCapability: "single_physical",
    windowCapability: "metric_window",
    actionCapability: "read_only",
    activeHrefs: [],
    railOrder: null,
  },
  {
    surfaceId: "creative-landing-pages",
    label: "Landing Pages",
    role: "tab",
    parentSurfaceId: "creative-studio",
    canonicalRoute: "/c/[businessId]/creative/landing-pages",
    aliases: ["/app/creative/landing-pages"],
    legacyRedirect: ["/platforms/meta/landing-pages"],
    mountedBody: "components/creatives/CreativeStudioExact.tsx",
    providerAccountCapability: "single_physical",
    windowCapability: "metric_window",
    actionCapability: "read_only",
    activeHrefs: [],
    railOrder: null,
  },
  {
    surfaceId: "creative-inbox",
    label: "Inbox",
    role: "tab",
    parentSurfaceId: "creative-studio",
    canonicalRoute: "/c/[businessId]/creative/inbox",
    aliases: ["/app/creative/inbox"],
    legacyRedirect: ["/platforms/meta/creative-inbox"],
    mountedBody: "components/creatives/CreativeStudioExact.tsx",
    providerAccountCapability: "single_physical",
    // Events, not metrics: the Inbox answers "what arrived in this range".
    windowCapability: "event_window",
    actionCapability: "internal_write",
    activeHrefs: [],
    railOrder: null,
  },
  {
    surfaceId: "creative-audiences",
    label: "Audiences",
    role: "tab",
    parentSurfaceId: "creative-studio",
    canonicalRoute: "/c/[businessId]/creative/audiences",
    aliases: ["/app/creative/audiences"],
    // ADR-004. The vendored contract records this legacy path as merged into
    // Meta Intelligence; that record predates Dashboard v2 restoring Audiences
    // as the fifth Creative Studio tab, and the destination is here.
    legacyRedirect: ["/platforms/meta/audiences"],
    mountedBody: "components/creatives/CreativeStudioExact.tsx",
    providerAccountCapability: "single_physical",
    windowCapability: "metric_window",
    actionCapability: "read_only",
    activeHrefs: [],
    railOrder: null,
  },

  // ---- Sub-surfaces: reachable, no rail row of their own --------------------
  {
    surfaceId: "creative-briefs",
    label: "Briefs",
    role: "sub",
    parentSurfaceId: "creative-studio",
    canonicalRoute: "/c/[businessId]/creative/briefs",
    aliases: ["/app/creative/briefs"],
    legacyRedirect: [],
    mountedBody: "components/zero-base/creative/studio-clients.tsx",
    providerAccountCapability: "single_physical",
    windowCapability: "current_state",
    actionCapability: "internal_write",
    activeHrefs: [],
    railOrder: null,
  },
  {
    surfaceId: "creative-shares",
    label: "Shares",
    role: "sub",
    parentSurfaceId: "creative-studio",
    canonicalRoute: "/c/[businessId]/creative/shares",
    aliases: ["/app/creative/shares"],
    legacyRedirect: [],
    mountedBody: "components/zero-base/creative/studio-clients.tsx",
    // The ledger is business-wide; each share freezes its own source account.
    providerAccountCapability: "business_scope",
    windowCapability: "current_state",
    actionCapability: "internal_write",
    gate: "META_PUBLIC_SHARE_MINT",
    activeHrefs: [],
    railOrder: null,
  },
  {
    surfaceId: "creative-detail",
    label: "Creative Detail",
    role: "sub",
    parentSurfaceId: "creative-studio",
    canonicalRoute: "/c/[businessId]/creative/[creativeId]",
    aliases: ["/app/creative/[creativeId]"],
    legacyRedirect: [],
    mountedBody: "components/zero-base/creative/detail-client.tsx",
    providerAccountCapability: "single_physical",
    // Frozen decision evidence beside current presentation enrichment (D066).
    windowCapability: "mixed",
    actionCapability: "read_only",
    activeHrefs: [],
    railOrder: null,
  },
  {
    surfaceId: "public-creative-share",
    label: "Public Creative Share",
    role: "public",
    canonicalRoute: "/share/creative/[token]",
    aliases: [],
    legacyRedirect: [],
    mountedBody: "components/zero-base/creative/public-share-page.tsx",
    // The token carries a frozen projection. No session, and no account picker.
    providerAccountCapability: "token_public",
    windowCapability: "current_state",
    actionCapability: "internal_write",
    activeHrefs: [],
    railOrder: null,
  },
  {
    surfaceId: "manage-integrations",
    label: "Integrations",
    role: "sub",
    canonicalRoute: "/c/[businessId]/manage/integrations",
    aliases: ["/app/manage/integrations"],
    legacyRedirect: ["/integrations"],
    mountedBody: "components/integrations/IntegrationsExact.tsx",
    providerAccountCapability: "assignment",
    windowCapability: "current_state",
    actionCapability: "assignment_write",
    activeHrefs: [],
    railOrder: null,
  },
];

const BY_ID = new Map(
  META_SURFACES.map((surface) => [surface.surfaceId, surface]),
);

export function metaSurfaceById(surfaceId: string): MetaSurface | null {
  return BY_ID.get(surfaceId) ?? null;
}

/** The usable Meta rail rows, in their fixed order. */
export function metaRailSurfaces(): readonly MetaSurface[] {
  return META_SURFACES.filter(
    (surface): surface is MetaSurface & { railOrder: number } =>
      surface.railOrder !== null,
  ).sort((a, b) => a.railOrder - b.railOrder);
}

/** The five D3 Creative Studio tabs, hub first. */
export function creativeStudioTabSurfaces(): readonly MetaSurface[] {
  return [
    metaSurfaceById("creative-studio")!,
    ...META_SURFACES.filter(
      (surface) =>
        surface.role === "tab" && surface.parentSurfaceId === "creative-studio",
    ),
  ];
}

/**
 * Every spelling that must resolve to a surface, canonical first.
 *
 * Used by the route-existence gate (T4) so a navigable path that 404s is a test
 * failure rather than something an operator discovers.
 */
export function allSurfaceSpellings(): ReadonlyArray<{
  readonly surfaceId: string;
  readonly path: string;
  readonly kind: "canonical" | "alias" | "legacy";
}> {
  return META_SURFACES.flatMap((surface) => [
    {
      surfaceId: surface.surfaceId,
      path: surface.canonicalRoute,
      kind: "canonical" as const,
    },
    ...surface.aliases.map((path) => ({
      surfaceId: surface.surfaceId,
      path,
      kind: "alias" as const,
    })),
    ...surface.legacyRedirect.map((path) => ({
      surfaceId: surface.surfaceId,
      path,
      kind: "legacy" as const,
    })),
  ]);
}

/**
 * Whether the topbar reporting-range picker applies to a surface (§8.2).
 *
 * `current_state` returns false, which is the point: Automation, Integrations
 * and the Shares ledger showed an active range they never applied, so the
 * operator read control state through a window that was not doing anything.
 */
export function surfaceUsesReportingWindow(surface: MetaSurface): boolean {
  return (
    surface.windowCapability !== "current_state" &&
    surface.windowCapability !== "fixed_evidence"
  );
}

/**
 * Which surface a pathname is, across all three route families.
 *
 * `[businessId]` and other dynamic segments match any single segment, so
 * `/c/biz_1/creative/abc123` resolves to Creative Detail rather than to nothing.
 * Longer patterns are tried first so a concrete route wins over a dynamic one
 * that would also match it.
 */
const SPELLING_PATTERNS: ReadonlyArray<{
  readonly segments: readonly string[];
  readonly surfaceId: string;
}> = META_SURFACES.flatMap((surface) =>
  [surface.canonicalRoute, ...surface.aliases, ...surface.legacyRedirect].map(
    (path) => ({
      segments: path.split("/").filter(Boolean),
      surfaceId: surface.surfaceId,
    }),
  ),
).sort((a, b) => b.segments.length - a.segments.length);

function segmentMatches(pattern: string, actual: string): boolean {
  return pattern.startsWith("[") && pattern.endsWith("]")
    ? actual.length > 0
    : pattern === actual;
}

export function metaSurfaceForPathname(pathname: string): MetaSurface | null {
  const actual = (pathname.split(/[?#]/, 1)[0] ?? "")
    .split("/")
    .filter(Boolean);
  for (const candidate of SPELLING_PATTERNS) {
    if (candidate.segments.length !== actual.length) continue;
    if (
      candidate.segments.every((segment, index) =>
        segmentMatches(segment, actual[index]!),
      )
    ) {
      return metaSurfaceById(candidate.surfaceId);
    }
  }
  return null;
}

/**
 * How the topbar's reporting-range picker should behave on a pathname (§8.2).
 *
 * `applies: false` is the case that matters. Current-state surfaces and
 * surfaces with their own fixed evidence window do not read the global range.
 *
 * A pathname this registry does not know returns `applies: true` with no note.
 * That is the conservative answer: the picker keeps working as it does today
 * everywhere outside the Meta family, and an unregistered surface is not
 * silently stripped of a control it may need.
 */
export interface ReportingWindowApplicability {
  readonly applies: boolean;
  /** Whether this surface consumes the comparison range as well. */
  readonly comparisonApplies: boolean;
  readonly surfaceId: string | null;
  /** Shown beside the disabled picker. Null when the picker applies. */
  readonly note: string | null;
}

export function reportingWindowApplicability(
  pathname: string,
): ReportingWindowApplicability {
  const surface = metaSurfaceForPathname(pathname);
  if (!surface)
    return {
      applies: true,
      comparisonApplies: true,
      surfaceId: null,
      note: null,
    };
  if (surfaceUsesReportingWindow(surface)) {
    // Creative Studio reads the primary reporting window only. Its comparison
    // board compares selected rows, not a second date range, so exposing the
    // shell comparison control would promise a query the surface never makes.
    const isCreativeStudioSurface =
      surface.surfaceId === "creative-studio" ||
      surface.parentSurfaceId === "creative-studio";
    return {
      applies: true,
      comparisonApplies:
        !isCreativeStudioSurface &&
        (surface.windowCapability === "metric_window" ||
          surface.windowCapability === "mixed"),
      surfaceId: surface.surfaceId,
      note: null,
    };
  }
  return {
    applies: false,
    comparisonApplies: false,
    surfaceId: surface.surfaceId,
    note: "The date range is not used on this screen.",
  };
}

import type {
  MetaCanonicalDecision,
  MetaDecisionsWorkspaceReadModel,
} from "@/lib/meta/decisions-workspace-contract";

/*
 * Its own module, with type-only imports, so the presentation can read the
 * projection without loading the reader (and its database client), and a
 * test that mocks the reader still gets the real accessor: a model the mock
 * built simply carries no projection, which reads as "unknown".
 */

/*
 * THE PRE-CAP LANE POPULATION, PROCESS-LOCAL LIKE THE IDENTITY UNIVERSE.
 *
 * `stateCounts` buckets the pre-cap candidates by `classification.decisionState`,
 * but the OS presentation serves each row in the lane `adAction` gives it, and
 * the two disagree on real rows: a D097 role-held Cut is `decisionState:
 * "blocked"` yet served in Act; a target-ineligible Scale/Cut/Refresh or a
 * native Cut without execution readiness is `act` yet served in Blocked; a
 * retained generation moves every Act row to review. The creative lane tabs
 * therefore counted one classification and drew another.
 *
 * So the reader keeps, for EVERY pre-cap candidate, the few fields that lane
 * function and the request-time governance hydration read — nothing else —
 * and the presentation runs the SAME lane function over them. The projection
 * never crosses the wire (the envelope still serializes only the selected
 * candidates) and never classifies anything itself.
 */
const META_DECISION_PRE_CAP_AD_CANDIDATES = Symbol.for(
  "adsecute.meta.decisions.pre-cap-ad-candidates",
);

type ReadModelWithPreCapAdCandidates = MetaDecisionsWorkspaceReadModel & {
  [META_DECISION_PRE_CAP_AD_CANDIDATES]?: readonly MetaCanonicalDecision[];
};

/** The lane-relevant subset of one candidate. @see adOsLaneForCanonicalDecision */
export function preCapLaneProjection(
  decision: MetaCanonicalDecision,
): MetaCanonicalDecision {
  const authority = decision.sourceAuthority;
  const resolution = decision.classification.resolution;
  return {
    decisionId: decision.decisionId,
    sourceSnapshotId: decision.sourceSnapshotId,
    parentChain: {
      ad: decision.parentChain.ad ? { id: decision.parentChain.ad.id } : null,
    },
    ...(decision.identityResolution
      ? {
          identityResolution: {
            adActionEligible: decision.identityResolution.adActionEligible,
          },
        }
      : {}),
    classification: {
      decisionState: decision.classification.decisionState,
      heldAction: decision.classification.heldAction,
      buyerAction: decision.classification.buyerAction,
      lifecycleRole: { value: decision.classification.lifecycleRole.value },
      resolution: resolution ? { code: resolution.code } : null,
    },
    ...(authority
      ? {
          sourceAuthority: {
            status: authority.status,
            actionEligible: authority.actionEligible,
            realAdId: authority.realAdId,
            executionReadiness: authority.executionReadiness,
            authorizedAction: authority.authorizedAction,
            engineVersion: authority.engineVersion,
          },
        }
      : {}),
    sourceDecision: {
      computedAt: decision.sourceDecision.computedAt,
      engineVersion: decision.sourceDecision.engineVersion,
    },
  } as unknown as MetaCanonicalDecision;
}

export function attachPreCapAdCandidates(
  readModel: MetaDecisionsWorkspaceReadModel,
  candidates: readonly MetaCanonicalDecision[],
) {
  Object.defineProperty(readModel, META_DECISION_PRE_CAP_AD_CANDIDATES, {
    value: candidates,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

/**
 * The pre-cap lane population, or null when the reader attached none (an
 * unavailable model, an older reader). Null is "unknown", never "empty".
 */
export function readMetaPreCapAdCandidates(
  readModel: MetaDecisionsWorkspaceReadModel,
): readonly MetaCanonicalDecision[] | null {
  return (
    (readModel as ReadModelWithPreCapAdCandidates)[
      META_DECISION_PRE_CAP_AD_CANDIDATES
    ] ?? null
  );
}

/**
 * The canonical page's half of the §9 envelope.
 *
 * A page knows four things before any data exists — who the actor is, what
 * they may do, whether the schema can be read, and which provider account (if
 * any) this request resolved to — and those four decide `refused` and
 * `degraded` outright. Waiting for a fetch to discover that a workspace never
 * chose an account is how a refusal came to look like an empty screen.
 *
 * This is the only server-side gatherer. It calls the same pure resolver the
 * API routes call, so the two cannot disagree about what a state means, and it
 * reads `requiresProviderAccount` from the WP2 registry rather than from a list
 * kept here — a surface's account capability has exactly one definition.
 */
import { metaSurfaceById } from "@/lib/meta/surface-registry";
import type { MetaFailureCode, MetaResponseEnvelope } from "@/lib/meta/read-state-contract";
import {
  resolveMetaSurfaceReadState,
  type MetaSurfaceEvidence,
} from "@/lib/meta/surface-read-state";
import {
  resolveProviderAccountScope,
  type ProviderScopeCatalog,
} from "@/lib/zero-base/provider-scope-server";

export interface MetaPageSurfaceStateInput {
  /** A `surfaceId` from the WP2 registry. Unknown ids throw rather than guess. */
  surfaceId: string;
  businessId: string;
  /** The `providerAccountId` search param, unverified. Never used as scope. */
  requestedAccountId?: string | null;
  permissions: { role: string | null; reviewerReadOnly: boolean; demo: boolean };
  /**
   * Set when the page already knows reading is impossible — a migration that
   * has not run, a capability the connected login does not have.
   */
  readBlockedBy?: MetaFailureCode;
  evidence?: MetaSurfaceEvidence;
  /** Reuse an authorized catalog rather than racing a second assignment read. */
  catalog?: ProviderScopeCatalog;
}

/**
 * Which surfaces serve nothing without one physical Meta account.
 *
 * D6's `single_physical`. `business_scope` (Integrations), `assignment` and
 * `token_public` (the public share) are not account-scoped, and requiring one
 * would refuse them for ever.
 */
export function metaSurfaceRequiresProviderAccount(surfaceId: string): boolean {
  const surface = metaSurfaceById(surfaceId);
  if (!surface) {
    throw new Error(
      `${surfaceId} is not a registered Meta surface. The account capability has one ` +
        "definition and it lives in the WP2 registry; a surface that is not there has none.",
    );
  }
  return surface.providerAccountCapability === "single_physical";
}

/**
 * Resolve the envelope a canonical page can render before it fetches anything.
 *
 * The result is `loading` in the ordinary case — deliberately. A page that
 * reported `success` before a single row had been read would be asserting a
 * successful read that has not happened, which is the same class of untruth as
 * a zero for a missing metric.
 */
export async function resolveMetaPageSurfaceState(
  input: MetaPageSurfaceStateInput,
): Promise<MetaResponseEnvelope<null>> {
  const requiresProviderAccount = metaSurfaceRequiresProviderAccount(input.surfaceId);

  const scope = await resolveProviderAccountScope({
    businessId: input.businessId,
    provider: "meta",
    requestedAccountId: input.requestedAccountId ?? null,
    catalog: input.catalog,
  }).catch(() => null);

  // An assignment read that fails is not a business with no accounts. §9.1 has
  // a code for exactly this, and it is `degraded`, not `refused`.
  if (!scope) {
    return resolveMetaSurfaceReadState({
      businessId: input.businessId,
      providerAccountId: null,
      requiresProviderAccount,
      permissions: input.permissions,
      capability: {
        canRead: false,
        canWrite: false,
        readBlockedBy: "provider_account_scope_unverified",
      },
      evidence: input.evidence,
    });
  }

  return resolveMetaSurfaceReadState({
    businessId: input.businessId,
    providerAccountId: scope.providerAccountId,
    scopeRefusal: scope.refusal,
    requiresProviderAccount,
    permissions: input.permissions,
    capability: {
      canRead: input.readBlockedBy === undefined,
      // Reviewer and demo are read-only by contract, and the envelope says so
      // rather than leaving a body to remember it.
      canWrite: !input.permissions.reviewerReadOnly && !input.permissions.demo,
      readBlockedBy: input.readBlockedBy,
    },
    evidence: input.evidence,
  });
}

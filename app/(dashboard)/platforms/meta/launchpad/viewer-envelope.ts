/**
 * The one server-produced answer to "may this viewer write here, and if not,
 * why".
 *
 * Launchpad used to derive that in the browser from two loose props
 * (`reviewerReadOnly`, `membershipRole`) and had no notion of a demo workspace
 * at all. Two problems with deriving it there. First, the UI ends up owning a
 * rule; when the server later adds or changes one, the two silently disagree
 * and the operator finds out by watching a 403 land on a control that looked
 * live. Second, a fact nobody forwards reads as permission — `undefined` role
 * became "not a guest", which is not the same statement.
 *
 * So the server computes the whole envelope once, and the surface renders it.
 * Nothing here is authorization: every Launchpad write route independently
 * refuses a reviewer, a sub-collaborator and a demo workspace on its own
 * authority. This exists so a refusal is visible BEFORE the click, not so the
 * refusal exists at all.
 */
import type { MembershipRole } from "@/lib/auth";
import type { LaunchpadWriteAuthority } from "@/app/api/launchpad/meta/demo-write-authority";

export type { LaunchpadWriteAuthority };

export interface LaunchpadViewerEnvelope {
  /** `null` only when no server established it (the preserved legacy mount). */
  role: MembershipRole | null;
  reviewerReadOnly: boolean;
  demo: boolean;
  canMutate: boolean;
  /** Non-null exactly when `canMutate` is false. Shown to the operator. */
  reason: string | null;
  /**
   * The code the route that would answer actually returns, non-null exactly
   * when `canMutate` is false. The client must RESTATE this, never re-derive
   * it: re-deriving produced "insufficient_role" for a workspace whose demo
   * flag merely could not be read, so the operator was told they lacked
   * permission when the server was going to answer 503 demo_status_unverified.
   */
  refusalCode:
    | "reviewer_read_only"
    | "demo_business_read_only"
    | "demo_status_unverified"
    | "insufficient_role"
    /**
     * The one code here that is NOT a route's answer, and it says so on
     * purpose. It means "no server resolved a viewer for this render", which
     * is a statement about this page, not a prediction about the endpoint.
     * Inventing one of the four codes above for it would be exactly the
     * re-derivation this envelope exists to prevent.
     */
    | "viewer_not_established"
    | null;
}

export const LAUNCHPAD_REVIEWER_REFUSAL =
  "Reviewer access is read-only. Launchpad writes are unavailable for this workspace.";

export const LAUNCHPAD_DEMO_REFUSAL =
  "Demo workspaces have zero Meta write authority. Launchpad writes are unavailable here.";

export const LAUNCHPAD_UNVERIFIED_REFUSAL =
  "This workspace could not be confirmed as a live (non-demo) workspace, so Launchpad writes are held.";

export const LAUNCHPAD_ROLE_REFUSAL =
  "Launchpad writes require collaborator access on this business.";

export const LAUNCHPAD_NOT_ESTABLISHED_REFUSAL =
  "This page did not establish who is looking, so Launchpad writes are held. Open Launchpad from your workspace to enable them.";

/**
 * Roles at or above `collaborator`, which is what every write route demands
 * through `requireLaunchpadBusinessAccess({ minRole: "collaborator" })`.
 */
const MUTATING_ROLES: ReadonlySet<MembershipRole> = new Set<MembershipRole>([
  "collaborator",
  "admin",
]);

/**
 * Order matters: the reason shown is the FIRST refusal that applies, spelled
 * the way the route that would answer spells it. A reviewer on the demo
 * workspace is told about reviewer access, because that is the refusal they
 * would hit first from `rejectIfLaunchpadReviewerReadOnly`.
 */
export function buildLaunchpadViewerEnvelope(input: {
  role: MembershipRole | null | undefined;
  reviewerReadOnly: boolean | undefined;
  writeAuthority: LaunchpadWriteAuthority;
}): LaunchpadViewerEnvelope {
  const role = input.role ?? null;
  const reviewerReadOnly = Boolean(input.reviewerReadOnly);
  const demo = input.writeAuthority === "demo";

  /**
   * `not_established` is the preserved legacy mount at
   * `/platforms/meta/launchpad`, and it REFUSES.
   *
   * It used to pass. The argument was that inventing a refusal would remove a
   * control the legacy page has always shown "on no evidence at all" — but
   * that reads an absence of evidence as evidence of authority, which is the
   * one direction a write gate may never fail. Nothing is established there:
   * `lib/zero-base/compatibility-page.tsx` mounts the legacy body with the
   * shim's own props and no viewer, so `role` is null, the reviewer posture is
   * unknown, and `businesses.is_demo_business` was never read. `canMutate:
   * true` then meant a reviewer, a guest and a demo admin all got ACTIVE Save
   * template / Save draft / Launch controls, and every one of those clicks is a
   * 403 the routes were always going to return — after the operator ran the
   * whole wizard.
   *
   * That mount is reachable in three of the four rollout modes and in the one
   * state where verification is impossible: `decideCompatibility` renders the
   * legacy body for `uiMode: "off"`, for every business-scoped path under
   * `internal`, for a non-allowlisted business under `allowlist`, and —
   * under `on` — whenever `authorizeBusiness` answers `schema_unavailable`,
   * which `applyDecision` maps to the legacy body. In that last case the
   * canonical route would have answered `unverified` and held the write, while
   * the legacy mount offered it.
   *
   * Refusing here removes no control from the screen: every consumer keeps the
   * control rendered and disabled with the reason in its title
   * (`viewerWriteRefusalReason`, `executionBlockedReason`), which is the same
   * treatment a reviewer and a demo workspace already get.
   */
  const reason = reviewerReadOnly
    ? LAUNCHPAD_REVIEWER_REFUSAL
    : demo
      ? LAUNCHPAD_DEMO_REFUSAL
      : input.writeAuthority === "unverified"
        ? LAUNCHPAD_UNVERIFIED_REFUSAL
        : input.writeAuthority === "not_established"
          ? LAUNCHPAD_NOT_ESTABLISHED_REFUSAL
          : role !== null && !MUTATING_ROLES.has(role)
            ? LAUNCHPAD_ROLE_REFUSAL
            : null;

  // Spelled exactly as the route that would answer spells it, in the same
  // precedence order as `reason` above, so the surface and the API can never
  // disagree about WHY a write is unavailable.
  const refusalCode = reviewerReadOnly
    ? ("reviewer_read_only" as const)
    : demo
      ? ("demo_business_read_only" as const)
      : input.writeAuthority === "unverified"
        ? ("demo_status_unverified" as const)
        : input.writeAuthority === "not_established"
          ? ("viewer_not_established" as const)
          : role !== null && !MUTATING_ROLES.has(role)
            ? ("insufficient_role" as const)
            : null;

  return {
    role,
    reviewerReadOnly,
    demo,
    canMutate: reason === null,
    reason,
    refusalCode,
  };
}

/**
 * What the preserved legacy mount gets: nothing established, therefore nothing
 * granted. `canMutate` is false — not because this surface decided the viewer
 * lacks authority, but because no server proved they have any, and an unproven
 * viewer is held rather than admitted. The routes still refuse on their own
 * authority; this only makes the refusal visible before the click.
 */
export const LAUNCHPAD_VIEWER_NOT_ESTABLISHED: LaunchpadViewerEnvelope =
  buildLaunchpadViewerEnvelope({
    role: null,
    reviewerReadOnly: false,
    writeAuthority: "not_established",
  });

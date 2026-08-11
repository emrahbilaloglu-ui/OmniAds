/**
 * The canonical Ops route matrix (H48, Flow J).
 *
 * Ops is a separate, role-gated product — not a buyer surface with an admin
 * tab. Two consequences are encoded here:
 *
 * 1. **Every legacy `/admin` route has exactly one canonical `/ops` tuple**, and
 *    the mapping is data rather than convention, so a missing or duplicated
 *    leaf is a test failure instead of a 404 somebody finds later. `/admin`
 *    stays intact; this is a mirror, not a migration.
 * 2. **Buyer surfaces link to none of it.** The count of Ops links reachable
 *    from buyer navigation is asserted to be zero: an operator-only product
 *    advertised in a buyer shell is an invitation to a page they cannot open.
 *
 * Operational logic is not restated here. Each Ops page mounts the existing
 * admin component, so confirmation, progress, error and read-back semantics
 * are literally the same code — adapting composition without duplicating
 * behaviour is the whole point of the work package.
 */

export interface OpsLeaf {
  /** Canonical Ops path. */
  ops: string;
  /** The legacy admin path it mirrors. */
  admin: string;
  label: string;
  group: "Overview" | "People" | "Commercial" | "Platform";
  /** True for routes with a dynamic segment. */
  dynamic: boolean;
}

export const OPS_LEAVES: readonly OpsLeaf[] = [
  { ops: "/ops", admin: "/admin", label: "Overview", group: "Overview", dynamic: false },
  { ops: "/ops/activity", admin: "/admin/activity", label: "Activity log", group: "Overview", dynamic: false },
  { ops: "/ops/auth-health", admin: "/admin/auth-health", label: "Auth health", group: "Platform", dynamic: false },
  { ops: "/ops/integrations", admin: "/admin/integrations", label: "Integration health", group: "Platform", dynamic: false },
  { ops: "/ops/sync-health", admin: "/admin/sync-health", label: "Sync health", group: "Platform", dynamic: false },
  { ops: "/ops/system-capacity", admin: "/admin/system-capacity", label: "System capacity", group: "Platform", dynamic: false },
  { ops: "/ops/release-authority", admin: "/admin/release-authority", label: "Release authority", group: "Platform", dynamic: false },
  { ops: "/ops/revenue-risk", admin: "/admin/revenue-risk", label: "Revenue risk", group: "Commercial", dynamic: false },
  { ops: "/ops/users", admin: "/admin/users", label: "Users", group: "People", dynamic: false },
  { ops: "/ops/users/[userId]", admin: "/admin/users/[userId]", label: "User detail", group: "People", dynamic: true },
  { ops: "/ops/businesses", admin: "/admin/businesses", label: "Workspaces", group: "People", dynamic: false },
  { ops: "/ops/businesses/[businessId]", admin: "/admin/businesses/[businessId]", label: "Workspace detail", group: "People", dynamic: true },
  { ops: "/ops/subscriptions", admin: "/admin/subscriptions", label: "Subscriptions", group: "Commercial", dynamic: false },
  { ops: "/ops/discounts", admin: "/admin/discounts", label: "Discount codes", group: "Commercial", dynamic: false },
  { ops: "/ops/discounts/new", admin: "/admin/discounts/new", label: "New discount", group: "Commercial", dynamic: false },
  { ops: "/ops/discounts/[codeId]", admin: "/admin/discounts/[codeId]", label: "Discount detail", group: "Commercial", dynamic: true },
];

export const OPS_GROUPS = ["Overview", "People", "Commercial", "Platform"] as const;

/** Nav shows only the non-dynamic leaves; a detail route has no standalone entry. */
export const OPS_NAV = OPS_LEAVES.filter((leaf) => !leaf.dynamic);

export function opsForAdmin(adminPath: string): OpsLeaf | null {
  return OPS_LEAVES.find((leaf) => leaf.admin === adminPath) ?? null;
}

export function adminForOps(opsPath: string): OpsLeaf | null {
  return OPS_LEAVES.find((leaf) => leaf.ops === opsPath) ?? null;
}

/**
 * Ops surface tokens.
 *
 * Instrumented separately from buyer surfaces so an Ops event can never be
 * attributed to a buyer session, and so a buyer dashboard cannot accidentally
 * inherit an Ops token and render as an operator console.
 */
export const OPS_SURFACE_TOKEN = "ops_console";
export const OPS_SHELL_ATTRIBUTE = "data-ops-shell";

/** Redirect target for a signed-in non-admin. Same as the legacy shell's. */
export const OPS_NON_ADMIN_REDIRECT = "/overview";

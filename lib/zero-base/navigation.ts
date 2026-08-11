/**
 * Navigation, derived from the leaf registry rather than hand-written.
 *
 * A hand-maintained nav list drifts: routes get added and never surface, or a
 * retired route lingers as a dead item. Deriving it from the 74 vendored
 * leaves means the nav and the URL authority cannot disagree.
 *
 * Two categories of leaf are deliberately *not* nav items:
 *
 * - Detail routes with their own dynamic id (`/creative/[creativeId]`,
 *   `/reports/[reportId]`). You reach them from a row, not from a rail; a nav
 *   item pointing at a pattern would be a dead link.
 * - Sub-actions of a leaf that is already listed (`/reports/new`,
 *   `/reports/[reportId]/edit`, the OAuth callback).
 *
 * Availability is not filtered here. A module the user cannot reach is
 * *absent* from the nav, never rendered as a disabled teaser — that decision
 * belongs to the caller, which knows the actor's role.
 */
import {
  GENERATED_LEAVES,
  type GeneratedLeaf,
  type LeafId,
} from "@/lib/zero-base/generated-contracts";

export type NavContext = "Agency" | "Client" | "Ops";

export interface NavItem {
  leaf: LeafId;
  label: string;
  /** Canonical pattern; `[businessId]` is substituted by `navHref`. */
  url: string;
  role: string;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

/** Sub-actions reached from within a leaf, never from the rail. */
const SUB_ACTION_SEGMENTS = new Set(["new", "edit", "print", "callback"]);

function isNavigable(leaf: GeneratedLeaf): boolean {
  const segments = leaf.url.split("/").filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    // `[businessId]` is the scope, supplied by the shell — any other dynamic
    // segment means this leaf needs an id the nav does not have.
    if (segment.startsWith("[") && segment !== "[businessId]") return false;
    if (index > 0 && SUB_ACTION_SEGMENTS.has(segment)) return false;
  }
  return true;
}

/** Group id is the segment after the scope, e.g. `meta`, `creative`. */
function groupIdFor(leaf: GeneratedLeaf, context: NavContext): string {
  const segments = leaf.url.split("/").filter(Boolean);
  if (context === "Client") {
    // /c/[businessId]/<group>/...
    return segments[2] ?? "home";
  }
  if (context === "Agency") return "desk";
  return "ops";
}

const GROUP_LABELS: Record<string, string> = {
  home: "Home",
  meta: "Meta",
  creative: "Creative",
  google: "Google",
  analytics: "Analytics",
  reports: "Reports",
  manage: "Manage",
  desk: "Agency Desk",
  ops: "Ops",
};

/** Rail order. Anything unlisted sorts after, alphabetically. */
const GROUP_ORDER = ["home", "meta", "creative", "google", "analytics", "reports", "manage"];

export function navGroupsFor(context: NavContext): NavGroup[] {
  const leaves = GENERATED_LEAVES.filter(
    (leaf) => leaf.ctx === context && isNavigable(leaf),
  );

  const groups = new Map<string, NavGroup>();
  for (const leaf of leaves) {
    const id = groupIdFor(leaf, context);
    if (!groups.has(id)) {
      groups.set(id, { id, label: GROUP_LABELS[id] ?? id, items: [] });
    }
    groups.get(id)!.items.push({
      leaf: leaf.leaf,
      label: leaf.label,
      url: leaf.url,
      role: leaf.role,
    });
  }

  return [...groups.values()].sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a.id);
    const bi = GROUP_ORDER.indexOf(b.id);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.id.localeCompare(b.id);
  });
}

/** Substitutes the scope into a canonical pattern. */
export function navHref(url: string, businessId: string | null): string {
  if (!url.includes("[businessId]")) return url;
  if (!businessId) return url;
  return url.replace("[businessId]", businessId);
}

/**
 * Strips the label's group prefix for rail display: the design writes
 * "Meta — Decisions" in the sitemap, but the rail already says "Meta".
 */
export function railLabel(label: string): string {
  const separator = label.indexOf(" — ");
  return separator === -1 ? label : label.slice(separator + 3);
}

/** True when `pathname` is the leaf currently being viewed. */
export function isCurrentNavItem(item: NavItem, pathname: string, businessId: string | null): boolean {
  return navHref(item.url, businessId) === pathname;
}

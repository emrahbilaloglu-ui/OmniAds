import {
  APP_STORE_PERSIST_KEY,
  useAppStore,
  type Business,
} from "@/store/app-store";
import {
  INTEGRATIONS_STORE_PERSIST_KEY,
  useIntegrationsStore,
} from "@/store/integrations-store";
import { clearAppQueryClient } from "@/lib/query-client";

export const AUTH_BOOTSTRAP_CACHE_KEY = "omniads_auth_bootstrap_at";

interface WorkspacePayload {
  userId: string;
  businesses: Business[];
  activeBusinessId: string | null;
}

// Exact production business-scoped preferences. Global layout/preferences and
// another live business's keys are preserved; storage values are never scanned.
const BUSINESS_BROWSER_PREFIXES = ["adsecute_active_platform_", "creatives-briefing-selected:",
  "adsecute:overview-layout:v1:", "creative-studio:assets:v1:"] as const;

function businessForBrowserKey(key: string): string | null {
  const prefix = BUSINESS_BROWSER_PREFIXES.find(p => key.startsWith(p));
  if (!prefix) return null;
  const suffix = key.slice(prefix.length);
  if (prefix === "adsecute:overview-layout:v1:" && suffix === "unscoped") return null;
  return prefix === "creative-studio:assets:v1:" ? suffix.split(":")[0] || null : suffix || null;
}

function pruneBusinessBrowserKeys(keep: (businessId: string) => boolean): boolean {
  if (typeof window === "undefined") return true;
  try {
    const keys = Object.keys(window.localStorage);
    for (const key of keys) {
      const owner = businessForBrowserKey(key);
      if (owner && !keep(owner)) window.localStorage.removeItem(key);
    }
    return true;
  } catch { return false; }
}

/** Call after durable server offboarding or a fresh list proves removal. Also cancels
 * in-flight cached reads so an old response cannot revive removed decisions. */
export function removeBusinessClientState(businessId: string): boolean {
  useAppStore.getState().deleteBusiness(businessId);
  useIntegrationsStore.getState().removeBusinessData(businessId);
  clearAppQueryClient();
  return pruneBusinessBrowserKeys(id => id !== businessId);
}

export function clearAuthScopedClientState() {
  useAppStore.getState().clearWorkspaceState();
  useAppStore.getState().setAuthBootstrapStatus("idle");
  useIntegrationsStore.getState().clearAllState();
  clearAppQueryClient();

  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem(AUTH_BOOTSTRAP_CACHE_KEY);
    window.localStorage.removeItem(APP_STORE_PERSIST_KEY);
    window.localStorage.removeItem(INTEGRATIONS_STORE_PERSIST_KEY);
  }
}

export function applyAuthenticatedWorkspace(payload: WorkspacePayload) {
  const currentOwnerId = useAppStore.getState().workspaceOwnerId;
  if (currentOwnerId && currentOwnerId !== payload.userId) {
    useIntegrationsStore.getState().clearAllState();
    clearAppQueryClient();
  }
  const allowed = new Set(payload.businesses.map(b => b.id));
  if (useAppStore.getState().businesses.some(b => !allowed.has(b.id))) clearAppQueryClient();
  pruneBusinessBrowserKeys(id => allowed.has(id));
  useIntegrationsStore
    .getState()
    .retainBusinesses(payload.businesses.map((business) => business.id));
  useAppStore
    .getState()
    .setWorkspaceSnapshot(payload.userId, payload.businesses, payload.activeBusinessId);
}

export function replaceAuthenticatedWorkspace(payload: WorkspacePayload) {
  clearAuthScopedClientState();
  const allowed = new Set(payload.businesses.map(b => b.id));
  pruneBusinessBrowserKeys(id => allowed.has(id));
  useAppStore
    .getState()
    .setWorkspaceSnapshot(payload.userId, payload.businesses, payload.activeBusinessId);
}

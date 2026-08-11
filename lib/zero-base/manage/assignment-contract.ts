/**
 * Provider account assignment, on the existing endpoints.
 *
 * This deliberately reuses `components/integrations/provider-assignment-drawer-support`
 * rather than reimplementing the round trip. That module already carries the
 * details a fresh client gets wrong — the save body is `{account_ids}` in
 * snake_case, the save path is `/businesses/[id]/[provider]/assign-accounts`
 * (not under `/api`), and Meta and Google read from two different discovery
 * routes. Reimplementing it would duplicate the lane, authorization and
 * read-back semantics that live behind those endpoints.
 *
 * Both discovery routes answer `{data, meta, notice}`, where each row carries
 * `id`, `name` and an `assigned` flag.
 */
import {
  getProviderFetchPath,
  getProviderSavePath,
  saveProviderAssignments,
  type ProviderAccountRow,
} from "@/components/integrations/provider-assignment-drawer-support";

/** The providers with a real discovery route on disk. */
export const ASSIGNABLE_PROVIDERS = ["meta", "google"] as const;
export type AssignableProvider = (typeof ASSIGNABLE_PROVIDERS)[number];

export function isAssignableProvider(value: string): value is AssignableProvider {
  return (ASSIGNABLE_PROVIDERS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export interface AssignmentAccount {
  id: string;
  name: string;
  assigned: boolean;
  isManager: boolean;
}

/**
 * Adapt `{data, meta, notice}`.
 *
 * A body without a `data` array is refused rather than read as "no accounts":
 * an empty list and an unreadable response lead an operator to opposite
 * conclusions.
 */
export function adaptAccessibleAccounts(
  raw: unknown,
): { ok: true; accounts: AssignmentAccount[]; notice: string | null } | { ok: false; reason: string } {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    return {
      ok: false,
      reason: "The accessible accounts response could not be read, so no assignment is offered.",
    };
  }
  const accounts = raw.data.filter(isRecord).flatMap((row) => {
    const account = row as unknown as ProviderAccountRow;
    const id = typeof account.id === "string" ? account.id : String(account.id ?? "");
    if (!id) return [];
    return [
      {
        id,
        name: typeof account.name === "string" && account.name.trim() ? account.name : id,
        assigned: account.assigned === true,
        isManager: account.isManager === true,
      },
    ];
  });
  return {
    ok: true,
    accounts,
    notice: typeof raw.notice === "string" && raw.notice.trim() ? raw.notice : null,
  };
}

/** Ids currently assigned, from the served flags. Never from local state. */
export function assignedIds(accounts: readonly AssignmentAccount[]): string[] {
  return accounts.filter((account) => account.assigned).map((account) => account.id);
}

export { getProviderFetchPath, getProviderSavePath, saveProviderAssignments };
export type { ProviderAccountRow };

import { AsyncLocalStorage } from "node:async_hooks";

export interface MetaVerificationTimezoneRow {
  provider_account_id: string;
  account_timezone: string;
}

interface ObservationScope {
  sources: WeakMap<object, Map<string, Promise<MetaVerificationTimezoneRow[]>>>;
  entries: number;
  closed: boolean;
}

// Route graphs can contain separate module factories. Share the storage
// identity, while every top-level workspace request owns a fresh context.
const shared = globalThis as typeof globalThis & {
  __adsecuteMetaVerificationTimezoneScopeV1?: AsyncLocalStorage<ObservationScope>;
};
const scopes = (shared.__adsecuteMetaVerificationTimezoneScopeV1 ??=
  new AsyncLocalStorage<ObservationScope>());

function copyRows(rows: MetaVerificationTimezoneRow[]): MetaVerificationTimezoneRow[] {
  return rows.map((row) => ({
    provider_account_id: row.provider_account_id,
    account_timezone: row.account_timezone,
  }));
}

export function runWithMetaVerificationTimezoneObservations<T>(
  work: () => Promise<T>,
): Promise<T> {
  const current = scopes.getStore();
  if (current && !current.closed) return work();
  const scope: ObservationScope = {
    sources: new WeakMap(), entries: 0, closed: false,
  };
  return scopes.run(scope, async () => {
    try {
      return await work();
    } finally {
      // Existing SWR tasks may outlive the response. They must not continue
      // sharing this request's observations after its work has settled.
      scope.closed = true;
      scope.sources = new WeakMap();
      scope.entries = 0;
    }
  });
}

/** Only the unchanged published-verification timezone SELECT uses this. */
export async function observeMetaVerificationTimezones(
  source: object,
  key: string,
  load: () => Promise<MetaVerificationTimezoneRow[]>,
): Promise<MetaVerificationTimezoneRow[]> {
  const scope = scopes.getStore();
  if (!scope || scope.closed) return load();
  let entries = scope.sources.get(source);
  const existing = entries?.get(key);
  if (existing) return copyRows(await existing);
  // Bound memory, never the evidence population: excess keys still read.
  if (scope.entries >= 32) return load();
  if (!entries) {
    entries = new Map();
    scope.sources.set(source, entries);
  }
  // Own the original rows before exposing any consumer copy. A malformed
  // result fails here just as the caller's original row mapping would, so it
  // is evicted rather than retained as a successful observation.
  const pending = Promise.resolve().then(load).then(copyRows);
  entries.set(key, pending);
  scope.entries += 1;
  const ownEntries = entries;
  void pending.catch(() => {
    if (!scope.closed && ownEntries.get(key) === pending) {
      ownEntries.delete(key);
      scope.entries -= 1;
    }
  });
  // Callers own independent rows. No mutation of a consumer's array can alter
  // the retained observation or another reader's timezone interpretation.
  return copyRows(await pending);
}

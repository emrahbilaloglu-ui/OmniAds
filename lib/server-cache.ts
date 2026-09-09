type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  staleUntil: number;
  updatedAt: number;
};

type SharedStore = {
  entries: Map<string, CacheEntry<unknown>>;
  inflight: Map<string, Promise<unknown>>;
};

function getStore(): SharedStore {
  const globalStore = globalThis as typeof globalThis & {
    __omniadsServerCache?: SharedStore;
  };
  if (!globalStore.__omniadsServerCache) {
    globalStore.__omniadsServerCache = {
      entries: new Map(),
      inflight: new Map(),
    };
  }
  return globalStore.__omniadsServerCache;
}

function readEntry<T>(key: string): CacheEntry<T> | null {
  const entry = getStore().entries.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.staleUntil <= Date.now()) {
    getStore().entries.delete(key);
    return null;
  }
  return entry;
}

function writeEntry<T>(
  key: string,
  value: T,
  ttlMs: number,
  staleWhileRevalidateMs = 0,
): CacheEntry<T> {
  const now = Date.now();
  const entry: CacheEntry<T> = {
    value,
    expiresAt: now + ttlMs,
    staleUntil: now + ttlMs + staleWhileRevalidateMs,
    updatedAt: now,
  };
  getStore().entries.set(key, entry as CacheEntry<unknown>);
  return entry;
}

async function loadIntoCache<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number,
  staleWhileRevalidateMs = 0,
  shouldCache: (value: T) => boolean = () => true,
  evictStaleWhen: (value: T) => boolean = () => false,
): Promise<CacheEntry<T>> {
  const store = getStore();
  const existing = store.inflight.get(key) as
    Promise<CacheEntry<T>> | undefined;
  if (existing) return existing;

  const task = (async () => {
    const value = await loader();
    /*
      REVALIDATION SAID NO: EVICT, do not keep serving (Codex B17).

      Deliberately SEPARATE from `shouldCache`, which means "this value is a
      transient fail-closed reading, do not let it replace a last known good
      one" — a distinction the existing stale-on-failed-refresh contract
      depends on. This one means "the thing that was cached is no longer
      admissible", which is an answer rather than a failure to get one, and the
      only correct response to it is to stop serving the stale entry.

      Without this, a rejected revalidation merely declined to write, the stale
      entry survived, and a generation that had just been found inadmissible
      went on being served for the rest of the stale-while-revalidate window.
    */
    if (evictStaleWhen(value)) {
      getStore().entries.delete(key);
      const now = Date.now();
      return { value, expiresAt: now, staleUntil: now, updatedAt: now };
    }
    if (!shouldCache(value)) {
      const now = Date.now();
      return {
        value,
        expiresAt: now,
        staleUntil: now,
        updatedAt: now,
      };
    }
    return writeEntry(key, value, ttlMs, staleWhileRevalidateMs);
  })().finally(() => {
    store.inflight.delete(key);
  });

  store.inflight.set(key, task as Promise<unknown>);
  return task;
}

export async function getCachedValue<T>(input: {
  key: string;
  ttlMs: number;
  staleWhileRevalidateMs?: number;
  loader: () => Promise<T>;
  /** Keep transient fail-closed values from replacing a last-known-good read. */
  shouldCache?: (value: T) => boolean;
  /**
   * "What is cached is no longer admissible." A revalidation whose value
   * satisfies this REMOVES the entry, so the next read is a miss rather than
   * another stale serve. Distinct from `shouldCache`, which is about not
   * writing a transient reading.
   */
  evictStaleWhen?: (value: T) => boolean;
}): Promise<{
  value: T;
  cacheState: "fresh" | "stale" | "miss";
  updatedAt: number;
}> {
  const {
    key,
    ttlMs,
    staleWhileRevalidateMs = 0,
    loader,
    shouldCache = () => true,
    evictStaleWhen = () => false,
  } = input;
  const now = Date.now();
  const cached = readEntry<T>(key);
  if (cached && cached.expiresAt > now) {
    return {
      value: cached.value,
      cacheState: "fresh",
      updatedAt: cached.updatedAt,
    };
  }

  if (cached && cached.staleUntil > now) {
    /*
      STALE ON ERROR, BUT NOT STALE ON REJECTION.

      A background revalidation that throws is a transient failure — the
      network, a timeout, a busy database — and the last known good value is
      better than nothing, so the stale entry is kept and the error swallowed
      here rather than surfacing as an unhandled rejection. A revalidation that
      SUCCEEDS and is rejected by `shouldCache` evicts inside `loadIntoCache`,
      because that is an answer, not a failure to get one.
    */
    void loadIntoCache(
      key,
      loader,
      ttlMs,
      staleWhileRevalidateMs,
      shouldCache,
      evictStaleWhen,
    ).catch(() => undefined);
    return {
      value: cached.value,
      cacheState: "stale",
      updatedAt: cached.updatedAt,
    };
  }

  const loaded = await loadIntoCache(
    key,
    loader,
    ttlMs,
    staleWhileRevalidateMs,
    shouldCache,
    evictStaleWhen,
  );
  return {
    value: loaded.value,
    cacheState: "miss",
    updatedAt: loaded.updatedAt,
  };
}

export async function readThroughCache<T>(input: {
  key: string;
  ttlMs: number;
  loader: () => Promise<T>;
}): Promise<T> {
  const { value } = await getCachedValue({
    key: input.key,
    ttlMs: input.ttlMs,
    staleWhileRevalidateMs: 0,
    loader: input.loader,
  });
  return value;
}

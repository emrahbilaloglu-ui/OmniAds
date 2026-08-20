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
): Promise<CacheEntry<T>> {
  const store = getStore();
  const existing = store.inflight.get(key) as
    Promise<CacheEntry<T>> | undefined;
  if (existing) return existing;

  const task = (async () => {
    const value = await loader();
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
    void loadIntoCache(key, loader, ttlMs, staleWhileRevalidateMs, shouldCache);
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

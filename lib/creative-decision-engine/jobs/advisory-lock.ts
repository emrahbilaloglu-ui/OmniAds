/** Stable signed 64-bit FNV-1a key for PostgreSQL advisory locks. */
export function hashAdvisoryLock(key: string): bigint {
  const uint64Size = BigInt(2) ** BigInt(64);
  const int64Max = BigInt(2) ** BigInt(63) - BigInt(1);
  let hash = BigInt("14695981039346656037");

  for (let index = 0; index < key.length; index += 1) {
    hash ^= BigInt(key.charCodeAt(index) & 0xff);
    hash = (hash * BigInt("1099511628211")) % uint64Size;
  }

  return hash <= int64Max ? hash : hash - uint64Size;
}

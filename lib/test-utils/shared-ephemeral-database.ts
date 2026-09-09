/** Reuse only the canonical runner's explicitly marked throwaway database. */
export function sharedEphemeralDatabaseUrl(): string | null {
  if (process.env.ADSECUTE_EPHEMERAL_DB_SEAM !== "1") return null;
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("The ephemeral DB seam requires DATABASE_URL.");
  const url = new URL(raw);
  const port = Number(url.port);
  if (url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port <= 0 || [5432, 15432].includes(port)
    || !["/adsecute_migrations_from_zero", "/adsecute_receipt_focused"].includes(url.pathname)) {
    throw new Error("Refusing a shared DB outside the canonical ephemeral seam.");
  }
  return raw;
}

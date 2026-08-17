import { getDb, runDbTransaction } from "@/lib/db";
import {
  fetchGA4PropertyMetadata,
  normalizeCurrencyCode,
} from "@/lib/google-analytics-accounts";

/**
 * The late half of GA4 property currency.
 *
 * The code is written at property selection
 * (`app/api/google-analytics/select-property/route.ts`), from the Admin API's
 * `Property.currencyCode`. Every workspace that picked its property BEFORE that
 * write existed has `ga4PropertyId` and no `ga4PropertyCurrency` — verified
 * read-only against production for BskTR, Halıcızade and Tiles Workshop — so the
 * readers resolved `null` and every GA4 revenue figure rendered the em dash
 * permanently. A selection is not something a user repeats, so "it will be
 * filled in next time they select" is the same as "never".
 *
 * This module fills it from the same Admin read, once, on the first read that
 * needs it, and persists it beside `ga4PropertyTimeZone` so no later read
 * fetches again. Everything about it is written to be strictly less powerful
 * than the selection writer:
 *
 *   - it writes ONE key, `ga4PropertyCurrency`, and only when that key is
 *     absent or unusable. It can never change a selection, a credential or a
 *     connection's identity;
 *   - it carries the selection route's compare-and-set discipline: the
 *     `connection_generation:status` token is captured from the integration row
 *     the credential came from, and the write is refused if the connection has
 *     moved since. A reconnect landing inside the Admin round trip therefore
 *     loses this write rather than stamping the previous principal's currency
 *     onto the new connection;
 *   - it re-checks, under the row lock, that the property it fetched for is
 *     still the selected one;
 *   - it never throws. A failed Admin call, a refused compare-and-set or a
 *     dead database leaves the currency `null`, which is exactly today's
 *     behaviour: the surfaces render the em dash and the report still answers.
 *
 * It writes `integration_credentials.metadata` and nothing else, which is why
 * its registry entry in `scripts/read-path-write-reachability.ts` names that
 * table alone.
 */

/**
 * How long a property that could not produce a currency is left alone.
 *
 * Without it, a property whose Admin read is refused — a revoked
 * `analytics.readonly` grant, a property deleted under us — would mint one
 * Google call per analytics request, forever. The read still answers during the
 * cooldown; it answers with the em dash, which is what it would have answered
 * anyway.
 */
const CURRENCY_RETRY_COOLDOWN_MS = 15 * 60_000;

interface CurrencyResolutionState {
  /** key → epoch ms before which no further attempt is made. */
  cooldownUntil: Map<string, number>;
  /** key → the attempt already running, so N concurrent reads make ONE call. */
  inFlight: Map<string, Promise<string | null>>;
}

function getCurrencyResolutionState(): CurrencyResolutionState {
  const store = globalThis as typeof globalThis & {
    __adsecuteGa4CurrencyResolution?: CurrencyResolutionState;
  };
  if (!store.__adsecuteGa4CurrencyResolution) {
    store.__adsecuteGa4CurrencyResolution = {
      cooldownUntil: new Map(),
      inFlight: new Map(),
    };
  }
  return store.__adsecuteGa4CurrencyResolution;
}

/** Test seam. Production never calls this; the state is per-process by design. */
export function resetGa4PropertyCurrencyResolutionState(): void {
  const state = getCurrencyResolutionState();
  state.cooldownUntil.clear();
  state.inFlight.clear();
}

export interface Ga4PropertyCurrencyBackfillInput {
  businessId: string;
  /** `properties/{id}`, exactly as `metadata.ga4PropertyId` stores it. */
  propertyResourceName: string;
  accessToken: string;
  /**
   * `connection_generation:status`, read from the SAME integration row that
   * produced `accessToken`. `null` disables the write — a caller that cannot
   * name the generation it read under does not get to persist.
   */
  expectedConnectionGeneration: string | null;
}

/**
 * Fetch the property's ISO 4217 code and persist it, returning the code for
 * this request. Resolves `null` — never rejects — when the code cannot be
 * established, and the caller serves that `null` through untouched.
 */
export async function backfillGa4PropertyCurrency(
  input: Ga4PropertyCurrencyBackfillInput,
): Promise<string | null> {
  const key = `${input.businessId}:${input.propertyResourceName}`;
  const state = getCurrencyResolutionState();

  const cooldown = state.cooldownUntil.get(key);
  if (typeof cooldown === "number" && cooldown > Date.now()) return null;

  const running = state.inFlight.get(key);
  if (running) return running;

  const attempt = resolveAndPersistGa4PropertyCurrency(input)
    .then((currency) => {
      if (currency === null) {
        state.cooldownUntil.set(key, Date.now() + CURRENCY_RETRY_COOLDOWN_MS);
      } else {
        state.cooldownUntil.delete(key);
      }
      return currency;
    })
    .finally(() => {
      state.inFlight.delete(key);
    });

  state.inFlight.set(key, attempt);
  return attempt;
}

async function resolveAndPersistGa4PropertyCurrency(
  input: Ga4PropertyCurrencyBackfillInput,
): Promise<string | null> {
  let currencyCode: string | null = null;
  try {
    const metadata = await fetchGA4PropertyMetadata(
      input.accessToken,
      input.propertyResourceName,
    );
    currencyCode = normalizeCurrencyCode(metadata.currencyCode);
  } catch (error: unknown) {
    console.warn("[ga4-property-currency] admin_read_failed", {
      businessId: input.businessId,
      propertyId: input.propertyResourceName,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!currencyCode) return null;
  if (!input.expectedConnectionGeneration) return currencyCode;

  try {
    await persistGa4PropertyCurrency({
      businessId: input.businessId,
      propertyResourceName: input.propertyResourceName,
      currencyCode,
      expectedConnectionGeneration: input.expectedConnectionGeneration,
    });
  } catch (error: unknown) {
    // A read must answer even when the durable half of it cannot. The cost of a
    // failed persist is one more Admin call after the cooldown, not a 500.
    console.warn("[ga4-property-currency] persist_failed", {
      businessId: input.businessId,
      propertyId: input.propertyResourceName,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return currencyCode;
}

/**
 * The write. One key, one table, under the connection's own row lock.
 *
 * Returns whether the row was updated; `false` means a guard refused it — the
 * connection moved, the selection moved, or another request won the race — and
 * every one of those is a normal outcome, not an error.
 */
async function persistGa4PropertyCurrency(input: {
  businessId: string;
  propertyResourceName: string;
  currencyCode: string;
  expectedConnectionGeneration: string;
}): Promise<boolean> {
  const patch = JSON.stringify({ ga4PropertyCurrency: input.currencyCode });
  return runDbTransaction(async () => {
    const sql = getDb();
    const rows = (await sql`
      SELECT connection.id,
             connection.status,
             connection.connection_generation::text AS connection_generation,
             COALESCE(credential.metadata, '{}'::jsonb) AS metadata
      FROM provider_connections connection
      LEFT JOIN integration_credentials credential
        ON credential.provider_connection_id = connection.id
      WHERE connection.business_id = ${input.businessId}
        AND connection.provider = 'ga4'
      FOR UPDATE OF connection
    `) as Array<{
      id: string;
      status: string;
      connection_generation: string | null;
      metadata: Record<string, unknown> | null;
    }>;

    const current = rows[0] ?? null;
    if (!current) return false;

    // Byte-identical to the token `upsertIntegration` compares against, which is
    // what makes this the same compare-and-set the selection route runs.
    const observed = `${current.connection_generation ?? 1}:${current.status}`;
    if (observed !== input.expectedConnectionGeneration) return false;

    const metadata = current.metadata ?? {};
    if (metadata.ga4PropertyId !== input.propertyResourceName) return false;
    if (normalizeCurrencyCode(metadata.ga4PropertyCurrency) !== null) return false;

    await sql`
      UPDATE integration_credentials
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${patch}::jsonb,
          updated_at = now()
      WHERE provider_connection_id = ${current.id}
    `;
    return true;
  });
}

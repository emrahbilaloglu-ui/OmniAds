/**
 * `providerAccountId` is the one canonical parameter name for a provider ad
 * account, and `accountId` is a deprecated alias that is read but never minted.
 *
 * Two spellings for one fact is how a scope goes missing: a link written with
 * one and read with the other resolves to `null`, and `null` is indistinguishable
 * from "the operator has not chosen yet" — so a surface refuses for a selection
 * that was in the URL all along. WP4 item 1 makes the canonical name single;
 * item 2 keeps the alias readable for links already in the wild, and logs each
 * one so the tail can be observed and eventually removed.
 *
 * Nothing here authorizes anything. A parameter is a *request* for an account;
 * `resolveProviderAccountId` decides whether the business is assigned it.
 */

/** The canonical spelling. New links must use this and only this. */
export const PROVIDER_ACCOUNT_PARAM = "providerAccountId" as const;

/** Read but never written. Removed once telemetry shows no traffic on it. */
export const DEPRECATED_PROVIDER_ACCOUNT_PARAM = "accountId" as const;

export interface ProviderAccountParamRead {
  /** The requested id, or `null` when neither spelling carried one. */
  requestedAccountId: string | null;
  /** Which spelling supplied it, for telemetry and for the deprecation log. */
  source: "canonical" | "deprecated_alias" | "absent";
}

type ParamSource =
  | URLSearchParams
  | Record<string, string | string[] | undefined>
  | undefined
  | null;

function readParam(source: ParamSource, key: string): string | null {
  if (!source) return null;
  if (source instanceof URLSearchParams) return source.get(key)?.trim() || null;
  const value = source[key];
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return null;
}

/**
 * Read the requested account from either spelling, canonical first.
 *
 * When both are present the canonical one wins and the alias is ignored rather
 * than compared: two different ids in one URL is a caller bug, and picking the
 * "more specific" one would be guessing at an intent nobody stated.
 */
export function readProviderAccountParam(
  source: ParamSource,
  options?: { onDeprecatedAlias?: (value: string) => void },
): ProviderAccountParamRead {
  const canonical = readParam(source, PROVIDER_ACCOUNT_PARAM);
  if (canonical) return { requestedAccountId: canonical, source: "canonical" };

  const alias = readParam(source, DEPRECATED_PROVIDER_ACCOUNT_PARAM);
  if (alias) {
    options?.onDeprecatedAlias?.(alias);
    return { requestedAccountId: alias, source: "deprecated_alias" };
  }
  return { requestedAccountId: null, source: "absent" };
}

/**
 * Normalise a Meta ad-account id to one spelling at the Meta boundary.
 *
 * Meta answers `act_123456` from some edges and `123456` from others, and both
 * spellings are in links, in stored assignments and in operator-pasted URLs.
 * Comparing them as raw strings makes the same account fail to match itself, so
 * a correctly-assigned account resolves to `null` and the surface refuses —
 * §7.2 of the plan.
 *
 * The canonical form is the prefixed one, because that is what the Marketing
 * API returns for `/me/adaccounts` and therefore what assignments hold.
 *
 * Deliberately narrow: it normalises the prefix and nothing else. It does not
 * strip whitespace inside the id, accept a numeric type, or repair a malformed
 * id — an id we cannot recognise is returned unchanged so the assignment check
 * refuses it, rather than being coerced into something that might match.
 */
export function canonicalMetaAccountId(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^act_\d+$/.test(value)) return value;
  if (/^\d+$/.test(value)) return `act_${value}`;
  return value;
}

/** True when two spellings name the same Meta account. */
export function sameMetaAccount(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = canonicalMetaAccountId(a);
  const right = canonicalMetaAccountId(b);
  return left !== null && left === right;
}

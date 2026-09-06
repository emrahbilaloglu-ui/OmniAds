/**
 * D088 C1 — the Meta write context a budget execution needs, built from the
 * EXISTING credential boundary.
 *
 * `MetaAdsWriteContext` requires a token AND the connection generation it was
 * read under, because the pre-POST authority check compares that generation
 * again. Building it here, once, means the runtime never assembles a partial
 * context — and when the credential or the generation is unavailable it returns
 * `null` rather than a context missing the field the guard depends on.
 */
import { getMetaAccountContext } from "@/lib/meta/account-context";
import { readMetaAdsetBidState, type MetaAdsWriteContext } from "@/lib/meta/ads-write";

/**
 * The budget-specific refinement: the same write context, plus the account's
 * own verified currency.
 *
 * PR #272 review. A budget is a number of MINOR UNITS, which means nothing
 * without the currency it is denominated in — and Meta does not report
 * currency on a campaign or an ad set, so a budget read-back cannot supply it.
 * The only honest source is the ad account profile, which
 * `loadWriteCredentials` already reads here to confirm this business still
 * holds the account, and which normalises the code to an ISO-4217 triple
 * before anyone sees it.
 *
 * It is a SEPARATE type rather than a new field on `MetaAdsWriteContext`
 * because pauses, resumes, bid writes and every Launchpad create need no
 * currency at all; making it required on the shared context would have broken
 * all of them to fix budgets. It is REQUIRED here, because a budget write
 * without it cannot prove what its own amount means.
 */
export interface MetaBudgetWriteContext extends MetaAdsWriteContext {
  /** The account's verified, normalised ISO-4217 code. Never from a request. */
  accountCurrency: string;
}

function normalizeBudgetAccountCurrency(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

interface WriteCredentials {
  accessToken: string;
  connectionGeneration: string;
  accountProfile: { currency?: string | null };
}

/**
 * The one credential read both builders share, so a budget context and an
 * ordinary write context can never disagree about whether an account is held.
 */
async function loadWriteCredentials(input: {
  businessId: string;
  providerAccountId: string;
}): Promise<WriteCredentials | null> {
  const context = await getMetaAccountContext(input.businessId).catch(() => null);
  if (!context) return null;
  const credentials = context as unknown as {
    connected?: boolean;
    accessToken?: string | null;
    connectionGeneration?: string | null;
    accountProfiles?: Record<string, { currency?: string | null } | undefined>;
  };
  const accessToken = credentials.accessToken?.trim() ?? "";
  const connectionGeneration = credentials.connectionGeneration?.trim() ?? "";
  // The account must still be one this business holds, and BOTH authority
  // fields must be present: an absent generation is the "nothing to check"
  // state the write guard exists to refuse.
  if (credentials.connected !== true || !accessToken || !connectionGeneration) {
    return null;
  }
  const accountProfile = credentials.accountProfiles?.[input.providerAccountId];
  if (!accountProfile) return null;
  return { accessToken, connectionGeneration, accountProfile };
}

export async function buildMetaWriteContextForProposal(input: {
  businessId: string;
  providerAccountId: string;
}): Promise<MetaAdsWriteContext | null> {
  const credentials = await loadWriteCredentials(input);
  if (!credentials) return null;
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    accessToken: credentials.accessToken,
    connectionGeneration: credentials.connectionGeneration,
  };
}

/**
 * The same context, refused unless the account's currency is actually known.
 *
 * Fails closed on a missing profile OR a missing/blank currency: an execution
 * that cannot name the currency of the account it is about to write to has no
 * business POSTing a minor-unit amount at it.
 */
export async function buildMetaBudgetWriteContextForProposal(input: {
  businessId: string;
  providerAccountId: string;
}): Promise<MetaBudgetWriteContext | null> {
  const credentials = await loadWriteCredentials(input);
  if (!credentials) return null;
  // Re-normalize at the final write boundary. The account-context loader does
  // this already, but this keeps the exported builder fail-closed even if a
  // future source or a test double bypasses that loader's normalization.
  const accountCurrency = normalizeBudgetAccountCurrency(
    credentials.accountProfile.currency,
  );
  if (!accountCurrency) return null;
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    accessToken: credentials.accessToken,
    connectionGeneration: credentials.connectionGeneration,
    accountCurrency,
  };
}

/**
 * The ad set's LIVE bid, for a compare-and-set before a manual approval writes.
 *
 * Why it lives here rather than in the route. `executeMetaAutomationProposal`
 * takes `readBidBaseline` as an injected dependency precisely so the executor
 * never reaches the provider itself, and the route that supplies it is one of
 * the modules `automation-write-path.test.ts` forbids from importing
 * `@/lib/meta/ads-write` at all. This module is already the sanctioned place
 * where that import is allowed on the proposal path, so the reader is exported
 * from here and the route stays clean.
 *
 * Why it exists at all. The scheduled bid runtime re-reads the live cap before
 * writing (`lib/meta/scheduled-bid-runtime.ts`); the manual approval path did
 * not, so a queued +10% from 1000 to 1100 became an unintended CUT once the
 * live cap had moved to 1300. Wiring it is not optional: without a reader the
 * executor refuses every bid row outright, which would consume the operator's
 * proposal and settle it `failed` without a remedy.
 *
 * `null` is a refusal, never "the baseline still holds" — an unreadable
 * account, an unbuildable context and a failed provider read all collapse to it
 * deliberately.
 */
export async function readProposalBidBaseline(input: {
  businessId: string;
  providerAccountId: string;
  adsetId: string;
}): Promise<{ bidAmountMinor: number | null; bidStrategy: string | null } | null> {
  const ctx = await buildMetaWriteContextForProposal({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  if (!ctx) return null;
  const state = await readMetaAdsetBidState(ctx, input.adsetId).catch(() => null);
  if (!state || !state.ok) return null;
  return {
    bidAmountMinor: state.bidAmountMinor,
    bidStrategy: state.bidStrategy,
  };
}

import {
  upsertIntegration,
  SEARCH_CONSOLE_AUTHORITY_PROVIDER,
  type IntegrationRow,
} from "@/lib/integrations";
import { getSearchConsoleSiteType } from "@/lib/search-console";

/**
 * The only supported way to persist a Search Console property selection.
 *
 * Search Console is the one provider whose selection and whose AUTHORITY live on
 * different connections. The chosen property is stored on the `search_console`
 * connection, but the accessible-site listing that validated it — and every
 * later Search Console sync — runs on the GOOGLE credential. A plain Google
 * reconnect bumps only the Google generation, and the `search_console` upsert
 * the connect flow performs changes neither status nor account, so it does not
 * bump the Search Console generation either. The selection's own
 * compare-and-set therefore cannot see a Google principal change at all: a
 * reconnect as a different Google user during the listing would store a property
 * only the PREVIOUS principal can see, and every later sync would fail against
 * it in a way that reads as a provider outage.
 *
 * Binding both generations used to be an optional argument on
 * `upsertIntegration`, which the two writers happened to pass. An argument the
 * next writer can omit is not a guarantee, so the binding now lives here, as two
 * REQUIRED, non-nullable inputs, and `upsertIntegration` refuses — at compile
 * time through its parameter type and at run time through
 * `DerivedAuthorityRequiredError` — any Search Console write that names a
 * property without carrying it.
 *
 * Both generations must be captured from the SAME read, taken strictly BEFORE
 * the listing the selection is validated against. Capturing them afterwards
 * records the generation a concurrent reconnect had just produced, the
 * compare-and-set matches, and the stale selection commits — the precise failure
 * the compare-and-set exists to stop. `connectionGenerationTokenFromIntegration`
 * in `lib/provider-property-selection.ts` derives them from the rows the caller
 * already read, which is what makes that ordering natural to get right.
 */

/**
 * A caller that reached this writer without the evidence the write requires.
 *
 * Distinct from `ProviderConnectionGenerationConflictError`, which means a real
 * reconnect raced the request and retrying is sensible. This one means the
 * request never established what it was writing under, and retrying it
 * unchanged would fail the same way.
 */
export class SearchConsoleSelectionEvidenceError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`Search Console selection refused: ${detail}`);
    this.name = "SearchConsoleSelectionEvidenceError";
    this.field = field;
  }
}

export interface SearchConsoleSiteSelection {
  businessId: string;
  /**
   * The site URL exactly as the provider spelled it in the accessible-site
   * listing, from `assertSearchConsoleSiteAccessible`. Never the caller's
   * spelling: Search Console treats `sc-domain:example.com` and
   * `https://example.com/` as different properties with different permissions.
   */
  siteUrl: string;
  /**
   * `connection_generation:status` of the `search_console` connection, read
   * before the accessible-site listing.
   */
  searchConsoleConnectionGeneration: string;
  /**
   * `connection_generation:status` of the `google` connection, read before the
   * accessible-site listing. Non-optional: this is the whole point of the
   * writer.
   */
  googleConnectionGeneration: string;
  /** Existing credential metadata to merge under, from the same read. */
  existingMetadata?: Record<string, unknown> | null;
  /** The connection's original `connected_at`, preserved across selections. */
  connectedAt?: string | null;
}

function requireNonEmpty(value: string, field: string, detail: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new SearchConsoleSelectionEvidenceError(field, detail);
  return trimmed;
}

export async function writeSearchConsoleSiteSelection(
  input: SearchConsoleSiteSelection,
): Promise<IntegrationRow> {
  // A generation that degraded to an empty string, or a caller that stringified
  // a `null` token, would otherwise reach `upsertIntegration` as a comparison
  // that can never match — or, worse, as one that vacuously does. Refusing here
  // keeps "the write is bound" a fact rather than a hope about the inputs.
  const siteUrl = requireNonEmpty(
    input.siteUrl,
    "siteUrl",
    "no provider-verified site URL was supplied.",
  );
  const searchConsoleConnectionGeneration = requireNonEmpty(
    input.searchConsoleConnectionGeneration,
    "searchConsoleConnectionGeneration",
    "the Search Console connection generation is missing, so the write would not be bound to the connection it was computed under.",
  );
  const googleConnectionGeneration = requireNonEmpty(
    input.googleConnectionGeneration,
    "googleConnectionGeneration",
    "the Google connection generation is missing, so the write would not be bound to the principal that authorised the listing.",
  );

  const existingMetadata =
    input.existingMetadata && typeof input.existingMetadata === "object"
      ? input.existingMetadata
      : {};

  return upsertIntegration({
    businessId: input.businessId,
    provider: "search_console",
    status: "connected",
    providerAccountId: siteUrl,
    providerAccountName: siteUrl,
    expectedConnectionGeneration: searchConsoleConnectionGeneration,
    // Asserted INSIDE the write transaction, under the same row lock, so a
    // Google reconnect landing between the caller's last look and this write is
    // refused by the compare-and-set itself rather than by a check-then-act.
    expectedDerivedAuthority: {
      provider: SEARCH_CONSOLE_AUTHORITY_PROVIDER,
      connectionGeneration: googleConnectionGeneration,
    },
    metadata: {
      ...existingMetadata,
      siteUrl,
      siteType: getSearchConsoleSiteType(siteUrl),
      propertyName: siteUrl,
      connectedAt: input.connectedAt ?? new Date().toISOString(),
    },
  });
}

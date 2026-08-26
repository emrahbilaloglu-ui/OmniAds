/**
 * Account Intelligence composition (H17/H18).
 *
 * Nine authorities, each read on the server and each reported on its own terms.
 * The rule that shapes the whole module: a source that could not be read says
 * so, in its own row, with its own reason. Collapsing them into one "some data
 * missing" line would hide that the remedies differ — a token to reconnect, a
 * window to wait for, an account to assign — and folding a failed read into a
 * zero would state a fact nobody observed.
 *
 * Every section is read through `Promise.allSettled`, so one failing authority
 * degrades one row rather than the page. Nothing here computes a decision or a
 * metric: sections carry counts and states the read models themselves produced.
 */
import { getIntegrationStatusByBusiness } from "@/lib/integration-status";
import { readLatestMetaDecisionSnapshot } from "@/lib/meta/snapshot";
import { classifySourceFailure } from "@/lib/meta/source-failure-classifier";
import { META_FAILURES } from "@/lib/meta/read-state-contract";
import type { MetaFailureCode, MetaReadState } from "@/lib/meta/read-state-contract";
import type { MembershipRole } from "@/lib/auth";
import { resolveMetaSurfaceReadState } from "@/lib/meta/surface-read-state";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import {
  getMetaCanonicalOverviewSummary,
  getMetaCanonicalOverviewTrends,
} from "@/lib/meta/canonical-overview";
import { getMetaBreakdownsForRange } from "@/lib/meta/breakdowns-source";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import { readMetaAnomaliesForBusiness } from "@/lib/meta/anomalies";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import { labelKindDisplay } from "@/lib/meta/campaign-label-types";
import { readMetaDecisionsWorkspaceReadModel } from "@/lib/meta/decisions-workspace-read-model";
import {
  getMetaCreativesWarehousePayload,
  readMetaCreativesWarehouseObservedAt,
} from "@/lib/meta/creatives-warehouse";
import { dayCountInclusive } from "@/lib/meta/history";
import { getMetaAccountDailyCoverage } from "@/lib/meta/warehouse";
import type { ProviderSourceState } from "@/lib/zero-base/meta/automation-posture";

export interface IntelligenceFact {
  label: string;
  value: string;
}

export interface IntelligenceSection {
  key: string;
  label: string;
  state: ProviderSourceState;
  reason: string | null;
  /**
   * This section's own §9 read state.
   *
   * WP9's acceptance is "9 bölüm × 7 read state", and until now no per-section
   * §9 state existed anywhere: `data-read-state` was one value for the whole
   * page, and the per-section word was `ProviderSourceState`, a different
   * five-member vocabulary that the plan does not ask about.
   *
   * Derived by the ONE authority — `resolveMetaSurfaceReadState` — from this
   * section's own outcome, so a section and the page cannot come to disagree
   * about what the words mean. Five of the seven are producible here; `loading`
   * and `refreshing-with-stale` describe a read that is in flight, and these
   * eleven are composed in a single server render, so there is no per-section
   * in-flight moment to observe. Those two remain page-level, where
   * `MetaSurfaceStateLive` already owns them.
   */
  readState: MetaReadState;
  /** The §9.1 code behind this section's state, when it has one. */
  readFailureCode?: MetaFailureCode;
  /**
   * The §9.1 code behind a `degraded` section, when the failure was classified.
   *
   * Carried so a reader can branch on the cause — a schema migration and an
   * expired token need different remedies — without parsing the sentence. The
   * sentence is for the operator; this is for the code.
   *
   * Absent on a healthy section and on one that reported its own unavailability
   * in its own words, because neither is a classified read failure.
   */
  failureCode?: string;
  observedAt: string | null;
  facts: IntelligenceFact[];
  /** Present only on the two sections that own a control. */
  control?: SectionControl;
}

export interface MetaIntelligence {
  providerAccountId: string | null;
  sections: IntelligenceSection[];
  /** Set only when the whole surface cannot be composed. */
  unavailableReason: string | null;
}

/**
 * Whether this actor may act on the two control sections, and why not.
 *
 * One decision, made once, in the order the routes make it:
 * `/api/meta/recommendations/respond` and `/api/meta/snapshot/run-now` both
 * refuse a reviewer, both refuse a demo workspace, and both require at least a
 * collaborator. This RESTATES those refusals so they are visible before the
 * click; it does not create them, and the routes re-check on their own
 * authority.
 *
 * The actor is required rather than optional: see `readMetaIntelligence`'s own
 * note for why "no actor" is not a state this composer should be able to be in.
 */
function resolveSectionControls(actor: {
  role: MembershipRole;
  reviewerReadOnly: boolean;
  demo: boolean;
}): { enabled: boolean; refusalCode: MetaFailureCode | null; refusalMessage: string | null } {
  const refuse = (code: MetaFailureCode) => ({
    enabled: false,
    refusalCode: code,
    refusalMessage: META_FAILURES[code].message,
  });
  if (actor.reviewerReadOnly) return refuse("reviewer_read_only");
  if (actor.demo) return refuse("demo_business_read_only");
  if (actor.role === "guest") return refuse("insufficient_role");
  return { enabled: true, refusalCode: null, refusalMessage: null };
}

/** Shape of a read model that reports its own partial state. */
interface PartialAware {
  isPartial?: boolean;
  notReadyReason?: string | null;
}

/** What one authority hands back for its row. */
interface SectionOutcome {
  facts: IntelligenceFact[];
  partial?: PartialAware;
  /**
   * Set when the authority itself reported that it cannot serve. Its own words
   * are carried through, because "unavailable" alone does not tell the operator
   * whether to reconnect, wait, or assign an account.
   */
  unavailableReason?: string | null;
  /**
   * When *this* authority says its data was observed.
   *
   * It must come from the authority, never from this module's clock. A shared
   * `new Date()` used to be stamped on all eight rows, so a warehouse that last
   * synced days ago — and one that had never synced at all — both read
   * "Observed: <the moment the page was opened>". That is a timestamp nobody
   * measured standing in for an unknown one, and refreshing the page appeared to
   * refresh data that had not moved.
   *
   * `null` is the honest answer for an authority that reports no timestamp; the
   * view renders it as "Not recorded".
   */
  observedAt?: string | null;
  /**
   * A control this section owns, and whether the actor may use it.
   *
   * Two of WP9's nine sections are not readings at all — Recommendations
   * carries a respond control and Snapshot carries run-now — and until now
   * neither existed: the view took an `onRespond` prop the page never passed,
   * and run-now was a hard-coded disabled button with two literal sentences
   * beside it. The state is authored HERE, on the server, for the same reason
   * every other refusal is: a control whose availability the browser decides is
   * a control whose refusal the browser can be wrong about.
   */
  control?: SectionControl;
}

/** Whether a section's control may be used, and the §9.1 reason when it may not. */
export interface SectionControl {
  /** Which control this is, so the view renders the right one rather than guessing. */
  kind: "respond" | "run-snapshot";
  enabled: boolean;
  /**
   * The §9.1 code when the refusal is one of the dictionary's, and null when it
   * is not.
   *
   * A control can be unusable for a reason that is not a failure: a snapshot
   * that served no recommendations leaves the respond control with nothing to
   * act on, and calling that `source_read_failed` — or inventing a code for it
   * — would report a measured zero as a defect. In that case the code is null
   * and `refusalMessage` still carries the served sentence.
   */
  refusalCode: MetaFailureCode | null;
  /** The sentence for that refusal. Set whenever `enabled` is false. */
  refusalMessage: string | null;
  /**
   * What a `respond` control may act ON — the served recommendation ids, each
   * with the title the snapshot gave it.
   *
   * `/api/meta/recommendations/respond` writes one row per `recId` and has no
   * foreign key, so a client that invented an id would silently record an
   * operator decision against a recommendation that does not exist. The ids
   * therefore come from the same snapshot read that produced the count, and a
   * control with no targets is a control the view must refuse rather than
   * point elsewhere.
   *
   * Undefined for `run-snapshot`, which acts on the business, not on a row.
   */
  targets?: ReadonlyArray<RespondTarget>;
}

/** One recommendation a respond control may be used on. */
export interface RespondTarget {
  /** The `rec_id` the respond route writes, verbatim from the snapshot. */
  recId: string;
  /** The snapshot's own title for it. Never composed here. */
  label: string;
}

/**
 * A string an authority served, or null when it served something that is not
 * one.
 *
 * Every field on `IntelligenceSection` is declared `string | null` because the
 * view is a client component that prints them directly. The declaration is not
 * self-enforcing: these values cross a database driver, and `pg` hands back a
 * live `Date` for every `timestamptz`/`timestamp` column it is not told to
 * parse as text. A `Date` typed as `string` survives compilation, survives the
 * RSC payload — which serialises it faithfully, as a `Date` — and then reaches
 * `{row.observedAt}`, where React refuses it: "Objects are not valid as a React
 * child (found: [object Date])". That threw during render, the error boundary
 * replaced the whole route, and Account Intelligence showed nothing at all.
 *
 * So the declared type is enforced here, at the one place every section is
 * built, rather than trusted eight times over. A `Date` is a knowable instant
 * and becomes its ISO form; anything else that is not a string is discarded,
 * because a value we cannot name is not a value we may print.
 */
function asServedText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  return null;
}

/**
 * Turn one authority's outcome into a section.
 *
 * A rejected read is `degraded` with the verbatim error, never `unavailable`:
 * unavailable means the source has nothing to give, and a failed read means we
 * do not know which of the two it is.
 */
/**
 * This section's §9 read state, from the one authority.
 *
 * `resolveMetaSurfaceReadState` is the resolver every Meta surface already uses;
 * calling it per section with that section's single source keeps one definition
 * of what `partial` and `empty-proven` mean. A second mapping written here
 * would be a second opinion, and the first time the two disagreed a section
 * would contradict the page above it.
 *
 * `canRead: false` is how a source that threw, or one that reported it cannot
 * serve, reaches `degraded` — the resolver's own most-specific-first ordering
 * does the rest.
 */
function sectionReadState(input: {
  outcome: "failed" | "unavailable" | "partial" | "served" | "refused";
  failureCode: MetaFailureCode | null;
  rowCount: number;
}): { readState: MetaReadState; readFailureCode?: MetaFailureCode } {
  /*
   * `refused` is a decision about the ACTOR, not about a read.
   *
   * Every other outcome here describes what a source did; this one describes
   * what this membership may do with it, and it is decided once by the page and
   * passed down. It is passed straight through rather than run back through the
   * resolver, because the resolver would need a scope and a capability to
   * re-derive an answer the caller already holds — and re-deriving it is how a
   * section becomes the second authority on who may act.
   */
  if (input.outcome === "refused") {
    return {
      readState: "refused",
      ...(input.failureCode ? { readFailureCode: input.failureCode } : {}),
    };
  }
  const envelope = resolveMetaSurfaceReadState({
    businessId: "section",
    providerAccountId: null,
    // Scope is decided once, for the whole surface, by the page. A section that
    // re-decided it would be the second business resolver this must not become.
    requiresProviderAccount: false,
    permissions: { role: "guest", reviewerReadOnly: false, demo: false },
    capability:
      input.outcome === "failed" || input.outcome === "unavailable"
        ? {
            canRead: false,
            canWrite: false,
            readBlockedBy: input.failureCode ?? "source_read_failed",
          }
        : { canRead: true, canWrite: false },
    sources:
      input.outcome === "failed" || input.outcome === "unavailable"
        ? undefined
        : [
            {
              id: "section",
              outcome: input.outcome === "partial" ? "partial" : "served",
              rowCount: input.rowCount,
            },
          ],
  });
  return envelope.failure
    ? { readState: envelope.state, readFailureCode: envelope.failure.code }
    : { readState: envelope.state };
}

function section(
  key: string,
  label: string,
  outcome: PromiseSettledResult<SectionOutcome | null>,
): IntelligenceSection {
  if (outcome.status === "rejected") {
    /**
     * Classified, not printed verbatim.
     *
     * This used to render `outcome.reason.message` straight onto the screen.
     * A driver error carries the failing SQL, table and column names and
     * sometimes bound parameters; a fetch error carries the URL, which for a
     * provider call can carry an access token. And beyond the leak, `relation
     * "meta_page_status" does not exist` tells a media buyer nothing they can
     * act on, while "a pending database migration has not been applied" tells
     * them it is not their data and not their fault.
     *
     * The raw text is kept — logged here, where only an operator of the system
     * can read it — and stops being the sentence on the screen.
     */
    const failure = classifySourceFailure(outcome.reason);
    console.warn("[meta-intelligence] source read failed", {
      section: key,
      code: failure.code,
      detail: failure.detail,
    });
    return {
      key,
      label,
      state: "degraded",
      reason: failure.message,
      failureCode: failure.code,
      ...sectionReadState({ outcome: "failed", failureCode: failure.code, rowCount: 0 }),
      observedAt: null,
      facts: [],
    };
  }
  if (!outcome.value) {
    return {
      key,
      label,
      state: "unavailable",
      reason: "This source is not configured for this business.",
      /*
       * `schema_not_ready` rather than a new code. "Not configured for this
       * business" is the closed dictionary's existing sense of a source that
       * cannot be read yet, and §9.1 is a closed vocabulary on purpose — a
       * private code here would be one the operator-facing dictionary has no
       * sentence for.
       */
      ...sectionReadState({
        outcome: "unavailable",
        failureCode: "schema_not_ready",
        rowCount: 0,
      }),
      observedAt: null,
      facts: [],
    };
  }
  // The authority's own observation instant, or null. Never this module's clock.
  const observedAt = asServedText(outcome.value.observedAt);
  // Fact values reach the view unchanged, so they are held to the same rule as
  // the reasons and the timestamps: a printable string, or the honest
  // "Not reported". `count`/`tally` already answer that way; this catches the
  // fields that are passed straight through from a read model.
  const facts = outcome.value.facts.map((fact) => ({
    label: asServedText(fact.label) ?? "Not reported",
    value: asServedText(fact.value) ?? "Not reported",
  }));
  // An authority that reported itself unable to serve is reported that way,
  // in its own words. Printing "Serving" over a read model whose own `status`
  // is `unavailable` would be this surface asserting a system health the
  // source explicitly denied.
  if (outcome.value.unavailableReason) {
    return {
      key,
      label,
      state: "unavailable",
      reason:
        asServedText(outcome.value.unavailableReason) ??
        "This source reported that it cannot serve, without a reason.",
      ...sectionReadState({
        outcome: "unavailable",
        failureCode: "source_read_failed",
        rowCount: facts.length,
      }),
      observedAt,
      facts,
      /*
       * A control section keeps its control even when its read failed. The
       * refusal and the read failure are different facts: an operator who may
       * act should not be told they may not, just because the section behind
       * the control could not be read.
       */
      ...(outcome.value.control ? { control: outcome.value.control } : {}),
    };
  }
  const partial = outcome.value.partial;
  if (partial?.isPartial) {
    return {
      key,
      label,
      state: "partial",
      // The read model's own words. Rewriting them here would let this surface
      // disagree with the source about why it is incomplete.
      reason:
        asServedText(partial.notReadyReason) ??
        "This source returned an incomplete window.",
      ...sectionReadState({ outcome: "partial", failureCode: null, rowCount: facts.length }),
      observedAt,
      facts,
      ...(outcome.value.control ? { control: outcome.value.control } : {}),
    };
  }
  const control = outcome.value.control;
  /*
   * A control section that the actor may not use is `refused`, not `success`.
   *
   * The facts are still served — a reviewer can READ what the respond control
   * would act on — but §9's word for "you may see this and may not act" is
   * `refused`, and reporting `success` on a section whose only affordance is
   * denied would be the surface claiming it served something it did not.
   */
  if (control && !control.enabled) {
    return {
      key,
      label,
      state: "serving",
      reason: control.refusalMessage,
      ...sectionReadState({
        outcome: "refused",
        failureCode: control.refusalCode,
        rowCount: facts.length,
      }),
      observedAt,
      facts,
      control,
    };
  }
  return {
    key,
    label,
    state: "serving",
    reason: null,
    // `success` when the source contributed facts, `empty-proven` when it was
    // read and had none. The distinction §9 exists for, per section.
    ...sectionReadState({ outcome: "served", failureCode: null, rowCount: facts.length }),
    observedAt,
    facts,
    ...(control ? { control } : {}),
  };
}

function count(value: unknown): string {
  return Array.isArray(value) ? String(value.length) : "Not reported";
}

/**
 * A count the read model already computed.
 *
 * Anything that is not a finite number is "Not reported" rather than 0: a
 * missing field means nobody measured, and 0 would be a measurement.
 */
function tally(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "Not reported";
}

/**
 * How many labelled campaigns are listed one by one in the row.
 *
 * A display cap, not a filter — the true total is carried by the
 * "Labelled campaigns" fact above it, so a capped list never understates.
 */
const LABEL_FACT_LIMIT = 12;

/**
 * Why an account-scoped authority was not read.
 *
 * Every windowed source on this surface describes one advertising account. When
 * no single account resolves, the answer is that the source was not read — not
 * a business-wide read presented in its place. A business-wide total sitting in
 * a row the operator reads as "this account" is a wrong number, not a partial
 * one, and no reader can tell it apart from a right one.
 */
function noAccountReason(authority: string) {
  return `No single Meta account is selected, so ${authority} cannot be scoped.`;
}

/**
 * Why a business-wide authority was withheld from an account-scoped surface.
 *
 * Some canonical read models take a business and read every account assigned to
 * it. That is correct for the workspace overview and wrong here: this surface
 * names one account, and A+B under a heading that means B is a false statement
 * about B. Where the authority accepts no account filter, the section says so
 * instead of showing the wider read.
 */
function businessWideReason(authority: string) {
  return `${authority} reads every Meta account assigned to this business, so it cannot be scoped to the selected account. It is withheld rather than reported as this account's figures.`;
}

/**
 * Compose Account Intelligence for one business.
 *
 * `startDate`/`endDate` scope every windowed source to the same range, so two
 * sections cannot silently describe different periods.
 */
export async function readMetaIntelligence(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  /**
   * The account the caller already resolved, or `null` when none resolved.
   *
   * Omit the key entirely to keep the historical behaviour of deriving it from
   * the assignment here. A caller that passes it must have resolved it through
   * `resolveProviderAccountId`, which refuses an unassigned id and refuses to
   * pick one of several, so supplying it can only narrow scope to an account
   * this business already holds — never widen it.
   */
  providerAccountId?: string | null;
  /**
   * Who is asking, resolved by the caller through `requireBusinessPageContext`.
   *
   * REQUIRED, because the two control sections cannot be composed without it
   * and there is no honest §9.1 code for "we did not establish who is asking".
   * Making it optional meant inventing one — and the nearest existing code,
   * `capability_read_denied`, is declared `degraded`, which would have reported
   * a permission decision as a read failure. A caller that cannot say who is
   * asking has not authorized the request yet, and this composer is not the
   * place to discover that.
   */
  actor: {
    role: MembershipRole;
    reviewerReadOnly: boolean;
    demo: boolean;
  };
}): Promise<MetaIntelligence> {
  const { businessId, startDate, endDate } = input;
  const control = resolveSectionControls(input.actor);

  const integrations = await getIntegrationStatusByBusiness(businessId).catch(() => null);
  if (!integrations) {
    return {
      providerAccountId: null,
      sections: [],
      unavailableReason:
        "Integration status could not be read for this business, so no source state can be reported.",
    };
  }
  if (!integrations.meta) {
    return {
      providerAccountId: null,
      sections: [],
      unavailableReason: "Meta is not connected for this business.",
    };
  }

  // The accounts this business actually holds. Read unconditionally, because
  // two questions below need it: which account resolves, and whether a
  // business-wide authority can honestly stand for the selected one.
  //
  // `null` means the assignment could not be read at all, and is deliberately
  // not the same as `[]`. An unreadable assignment cannot prove that a
  // business-wide read covers exactly one account, so it must not be treated
  // as if it had.
  const assignment = await getProviderAccountAssignments(businessId, "meta").catch(
    () => null,
  );
  const assignedAccountIds = assignment?.account_ids ?? null;

  // One assigned account resolves; zero or several do not. Picking one of
  // several would scope every section below to an account nobody chose. When
  // the caller resolved the account itself (from the URL the shell and rail
  // write), that answer is used — it obeys the same refusal rules.
  let providerAccountId: string | null;
  if (input.providerAccountId !== undefined) {
    providerAccountId = input.providerAccountId?.trim() || null;
  } else {
    providerAccountId =
      assignedAccountIds?.length === 1 ? assignedAccountIds[0]! : null;
  }

  /**
   * Whether a business-wide read is, for this business, the selected account's
   * read.
   *
   * True only when the business holds exactly one assigned Meta account and it
   * is the selected one — then "every assigned account" and "this account" name
   * the same set, and the wider authority is not wider. Any other shape (several
   * assigned, none assigned, assignment unreadable) leaves the two apart, and
   * the sections that cannot filter must withhold rather than widen.
   */
  const businessWideIsThisAccount =
    providerAccountId !== null &&
    assignedAccountIds !== null &&
    assignedAccountIds.length === 1 &&
    assignedAccountIds[0] === providerAccountId;

  /**
   * One decision read, shared by the two sections that need it.
   *
   * Structure and Lane classify both describe the same snapshot, and reading it
   * twice per page load doubled the most expensive query on this surface for no
   * new information — against WP17's first-load request budget, and against the
   * plan's own "no duplicate/N+1 calls on first load".
   *
   * A shared promise rather than a hoisted await: a failure still reaches both
   * sections through their own `Promise.allSettled` slot and degrades exactly
   * those two, while the other nine are unaffected. That is the same isolation
   * two separate reads gave, without the second read.
   */
  const workspaceRead = providerAccountId
    ? readMetaDecisionsWorkspaceReadModel({ businessId, providerAccountId })
    : null;

  const [
    status,
    pulse,
    summary,
    trends,
    breakdowns,
    anomalies,
    labels,
    workspace,
    topCreatives,
    pageStatus,
    laneClassify,
    recommendations,
    snapshotRun,
  ] = await Promise.allSettled([
      // 1 · status — the connection and account assignment behind everything else.
      (async () => ({
        facts: [
          { label: "Meta connection", value: "Connected" },
          {
            label: "Selected account",
            value: providerAccountId ?? "None selected",
          },
        ],
        // An assigned-but-unselected account is a real half-state, not a failure.
        partial: providerAccountId
          ? undefined
          : {
              isPartial: true,
              notReadyReason:
                "No Meta account is selected for this business, so account-scoped sources cannot resolve.",
            },
        // The integration-status authority serves booleans and no timestamp, so
        // there is nothing here that was observed at a knowable instant.
        observedAt: null,
      }))(),

      // 2 · account pulse — campaign delivery in the window.
      (async () => {
        // A null `accountId` makes this source read every assigned account.
        // On a surface that names one account that is a business-wide fallback,
        // so the row refuses instead.
        if (!providerAccountId) {
          return {
            facts: [],
            unavailableReason: noAccountReason("the campaign delivery authority"),
            observedAt: null,
          };
        }
        const campaigns = await getMetaCampaignsForRange({
          businessId,
          startDate,
          endDate,
          accountId: providerAccountId,
        });
        // `rows` is the key this source actually serves; there is no
        // `campaigns` key on the result, and reading one left the tile blank.
        return {
          facts: [{ label: "Campaigns in window", value: count(campaigns.rows) }],
          partial: campaigns,
          // `MetaCampaignsSourceResult` carries no observation timestamp.
          observedAt: null,
        };
      })(),

      // 3 · summary
      (async () => {
        if (!providerAccountId) {
          return {
            facts: [],
            unavailableReason: noAccountReason("the canonical summary authority"),
            observedAt: null,
          };
        }
        // An UNREADABLE assignment is still a withhold, and it is a separate
        // law from the multi-account one. Narrowing needs to know what is
        // assigned; when that read failed, `assignedAccountIds` is null and
        // the narrowing would select nothing while LOOKING like a served
        // zero. Withheld, not zero.
        if (assignedAccountIds === null) {
          return {
            facts: [],
            unavailableReason: businessWideReason("The canonical summary authority"),
            observedAt: null,
          };
        }
        // Otherwise the summary is narrowed to the selected account, so a
        // header naming account B can no longer sit above A+B totals — which
        // is what forced this section to withhold on every multi-account
        // business. The narrowing is fail-closed inside the authority: an id
        // that is not currently assigned selects NOTHING rather than falling
        // back to the full set.
        const result = await getMetaCanonicalOverviewSummary({
          businessId,
          startDate,
          endDate,
          providerAccountId,
        });
        return {
          facts: [{ label: "Read source", value: result.readSource }],
          partial: result,
          // The warehouse's own last-observed instant for these rows: a live
          // refresh if one happened, otherwise the newest `updated_at` behind
          // the totals. Null when the source has never synced — which is a real
          // answer, and the one a "syncing" account must give.
          observedAt:
            result.freshness?.liveRefreshedAt ?? result.freshness?.lastSyncedAt ?? null,
        };
      })(),

      // 4 · trends
      (async () => {
        // This authority filters the assigned ids by `providerAccountId` and
        // falls back to all of them when it is null — a business-wide read
        // wearing an account-scoped row.
        if (!providerAccountId) {
          return {
            facts: [],
            unavailableReason: noAccountReason("the canonical trends authority"),
            observedAt: null,
          };
        }
        const result = await getMetaCanonicalOverviewTrends({
          businessId,
          startDate,
          endDate,
          providerAccountId,
        });
        return {
          facts: [
            { label: "Trend points", value: count((result as { points?: unknown }).points) },
          ],
          partial: result,
          // Deliberately null. This authority builds its `freshness` from the
          // points' *dates* (lib/meta/serving.ts, `getMetaWarehouseTrends`), so
          // its `lastSyncedAt` is the last day covered, not the instant anything
          // was observed. Printing a coverage date under "Observed" would be the
          // same substitution this field exists to avoid.
          observedAt: null,
        };
      })(),

      // 5 · breakdowns
      (async () => {
        if (!providerAccountId) {
          return {
            facts: [],
            unavailableReason: noAccountReason("the breakdowns authority"),
            observedAt: null,
          };
        }
        // The account was never passed, so this row reported every assigned
        // account's breakdowns beside account-scoped neighbours. The source has
        // always accepted the filter — and refuses an id the business does not
        // hold — so passing it can only narrow.
        const result = await getMetaBreakdownsForRange({
          businessId,
          providerAccountId,
          startDate,
          endDate,
        });
        return {
          facts: [{ label: "Status", value: String(result.status) }],
          partial: result as PartialAware,
          // Served for exactly this purpose: "so a reader can bind an as-of to a
          // measured instant instead of inventing one from its own clock"
          // (MetaBreakdownsResponse.freshness).
          observedAt: result.freshness?.liveRefreshedAt ?? result.freshness?.lastSyncedAt ?? null,
        };
      })(),

      // 6 · anomalies
      (async () => {
        if (!providerAccountId) {
          return {
            facts: [],
            unavailableReason: noAccountReason("the anomalies authority"),
            observedAt: null,
          };
        }
        const result = await readMetaAnomaliesForBusiness({
          businessId,
          providerAccountId,
          activeOnly: true,
          // The selected window's own bound. Without it this authority takes
          // `MAX(snapshot_date)` over all time, so a March window sat next to
          // today's anomaly snapshot on the same page, under one line claiming
          // every windowed source covered the same range. The read model
          // documents the parameter for exactly this: "Without it a historical
          // range would show today's anomalies."
          endDate,
        });
        return {
          facts: [
            { label: "Active anomalies", value: count((result as { anomalies?: unknown }).anomalies) },
          ],
          partial: result as PartialAware,
          // The snapshot these anomalies were actually read from. It is a date,
          // not an instant, and it is reported as the date it is — coarser than
          // a timestamp, but measured, which the request clock was not.
          observedAt: (result as { snapshotDate?: string | null }).snapshotDate ?? null,
        };
      })(),

      // 7 · campaign labels
      (async () => {
        if (!providerAccountId) {
          return {
            facts: [],
            unavailableReason: noAccountReason("the campaign label authority"),
            observedAt: null,
          };
        }
        const result = await readMetaCampaignLabels({ businessId });
        if (!Array.isArray(result)) {
          // Not an empty list — an answer we could not read. Zero would be a
          // count nobody took.
          return { facts: [{ label: "Labelled campaigns", value: "Not reported" }], observedAt: null };
        }
        // `readMetaCampaignLabels` keys only on the business, and a business
        // with two Meta accounts really does store labels for both (one such
        // account pair holds 18 labels and 3). Listing all of them beside
        // account-scoped rows attributed one account's campaigns to another.
        // Each row records the account it was written against, so the scope is
        // applied here rather than by widening the shared authority.
        const scoped = result.filter(
          (label) => label.providerAccountId === providerAccountId,
        );
        // A label written against another account — or against none, so not
        // attributable to this one — is excluded, and the exclusion is stated.
        // A silently shorter list is a different lie from a silently longer one.
        const withheld = result.length - scoped.length;
        return {
          facts: [
            { label: "Labelled campaigns", value: count(scoped) },
            // The labels themselves, so the Campaign labels aside can show what
            // was labelled rather than a bare count. A label with no stored
            // name falls back to its campaign id — never to a made-up name.
            ...scoped
              .slice(0, LABEL_FACT_LIMIT)
              .map((label) => ({
                label: label.campaignName ?? label.campaignId,
                value: labelKindDisplay(label.kind),
              })),
          ],
          partial:
            withheld > 0
              ? {
                  isPartial: true,
                  notReadyReason: `${withheld} labelled campaign${withheld === 1 ? "" : "s"} in this business ${withheld === 1 ? "is" : "are"} recorded against another Meta account, or against none, and ${withheld === 1 ? "is" : "are"} not counted here.`,
                }
              : undefined,
          // Deliberately null. `MetaCampaignLabel` carries `labeledAt` and
          // `updatedAt` — when a person authored or last edited the label — and
          // neither is an observation of an account. Only the history projection
          // (`MetaCampaignLabelHistoryState.observedAt`) records one, and this
          // read does not return it. Printing an authorship time under
          // "Observed" would misname it.
          observedAt: null,
        };
      })(),

      // 8+9 · structure and recommendations both come from the decisions
      //       workspace read model, which is their shared authority.
      (async () => {
        if (!providerAccountId) {
          return {
            facts: [],
            unavailableReason:
              "No single Meta account is selected, so the decisions authority cannot be scoped.",
            observedAt: null,
          };
        }
        const model = await workspaceRead!;
        // The read model reports its own health. It carries no `isPartial`, so
        // the partial path below can never fire for it — without this branch an
        // authority that said `unavailable` was rendered green as "Serving".
        if (model.status !== "available") {
          return {
            facts: [],
            unavailableReason:
              model.unavailable?.message ??
              "The decisions authority reported that it cannot serve, without a reason.",
            // A model that cannot serve still names when its snapshot was
            // computed, when it has one; `generatedAt` is deliberately not used
            // — that is the read model's own request clock, not an observation.
            observedAt: model.source?.computedAt ?? null,
          };
        }
        const queue = model.queue;
        return {
          facts: [
            // Pre-cap counts: what the source produced and what reached the
            // queue, before any top-N display cap. Both are the read model's
            // own numbers — nothing here recomputes a decision.
            { label: "Decision rows read", value: tally(queue?.sourcePreCapCount) },
            { label: "Queued for review", value: tally(queue?.queuedPreCapCount) },
            ...Object.values(queue?.sections ?? {}).map((queueSection) => ({
              label: queueSection.label,
              value: tally(queueSection.preCapCount),
            })),
          ],
          // When the decision snapshot behind these counts was computed. Not
          // `model.generatedAt`, which the read model fills from its own clock
          // at request time and would restate the bug this field replaced.
          observedAt: model.source?.computedAt ?? null,
        };
      })(),

      // 9 · top creatives — the creative authority, read from the warehouse.
      //
      // Deliberately NOT `/api/meta/top-creatives`, which performs live Meta
      // Graph fetches inside its own route handler. Composing that here would
      // put provider calls on every render of this page, against WP17's
      // first-load request budget and into Meta's rate limits — and
      // reimplementing it would create a second creative authority, which is
      // the drift this plan exists to end. `getMetaCreativesWarehousePayload`
      // is the same warehouse reader Creative Studio serves from.
      (async () => {
        if (!providerAccountId) {
          return {
            facts: [],
            unavailableReason: noAccountReason("the creative authority"),
            observedAt: null,
          };
        }
        const payload = await getMetaCreativesWarehousePayload({
          businessId,
          providerAccountId,
          start: startDate,
          end: endDate,
          groupBy: "creative",
          format: "all",
          sort: "spend",
          mediaMode: "metadata",
        });
        // The reader reports its own scope refusal rather than throwing, so an
        // unassigned or ambiguous account is named instead of counted as zero.
        if (payload.status !== "ok") {
          return {
            facts: [],
            unavailableReason:
              "The creative authority could not be scoped to the selected account.",
            observedAt: null,
          };
        }
        const rows = payload.rows ?? [];
        const observedAt = await readMetaCreativesWarehouseObservedAt({
          businessId,
          providerAccountId,
          start: startDate,
          end: endDate,
          groupBy: "creative",
        });
        return {
          facts: [
            { label: "Creatives in window", value: count(rows) },
            {
              // The reader's own partial marker, not a recomputation.
              label: "Rows with metrics",
              value: count(
                rows.filter(
                  (row) =>
                    (row as { metricsAvailability?: string })
                      .metricsAvailability !== "unavailable",
                ),
              ),
            },
          ],
          partial: payload as PartialAware,
          observedAt,
        };
      })(),

      // 10 · page status — pipeline readiness for this account's window.
      //
      // Composed from the same coverage readers `/api/meta/page-status` uses,
      // not from the 649-line route: `rollupMetaSurfaceCollection` and the
      // coverage functions are already the canonical authority, and the route
      // is presentation over them.
      (async () => {
        if (!providerAccountId) {
          return {
            facts: [],
            unavailableReason: noAccountReason("the page-status authority"),
            observedAt: null,
          };
        }
        const coverage = await getMetaAccountDailyCoverage({
          businessId,
          providerAccountId,
          startDate,
          endDate,
        });
        const expectedDays = dayCountInclusive(startDate, endDate);
        // The coverage reader's own field. `completed_days` counts days that
        // finished, which is the number a "days covered" claim rests on.
        const coveredDays = coverage?.completed_days ?? null;
        return {
          facts: [
            {
              label: "Days covered",
              value:
                coveredDays == null
                  ? "Not reported"
                  : `${coveredDays} of ${expectedDays}`,
            },
            {
              label: "Ready through",
              value: asServedText(coverage?.ready_through_date) ?? "Not reported",
            },
          ],
          // A window that is not fully covered is partial, and says so rather
          // than presenting a short read as the whole period.
          partial:
            coveredDays != null && coveredDays < expectedDays
              ? ({
                  isPartial: true,
                  partialReason: `Only ${coveredDays} of ${expectedDays} days in this window have been synced.`,
                } as PartialAware)
              : undefined,
          // The coverage read's own latest write time. Not this module's clock:
          // an account that has never synced must not read as observed just now.
          observedAt: asServedText(coverage?.latest_updated_at) ?? null,
        };
      })(),

      // 11 · lane classify — from the canonical decision read model.
      //
      // The same `readMetaDecisionsWorkspaceReadModel` the structure section
      // already reads, so the two cannot disagree about the snapshot. Its
      // `queue.sections` IS the lane classification; `/api/meta/lane-classify`
      // is a 1 969-line surface over the same authority and reimplementing any
      // of it here would create a second classifier.
      (async () => {
        if (!providerAccountId) {
          return {
            facts: [],
            unavailableReason: noAccountReason("the lane classifier"),
            observedAt: null,
          };
        }
        const model = await workspaceRead!;
        if (model.status !== "available") {
          return {
            facts: [],
            unavailableReason:
              model.unavailable?.message ??
              "The lane classifier reported that it cannot serve, without a reason.",
            observedAt: model.source?.computedAt ?? null,
          };
        }
        const candidates = model.queue?.adCandidates ?? null;
        return {
          facts: [
            {
              label: "Deduplication grain",
              value: asServedText(model.queue?.deduplicationGrain) ?? "Not reported",
            },
            {
              // Exact provider-ad identities the classifier selected, before
              // any display cap. Absent on a v1 payload, which reads as
              // "not reported" rather than zero.
              label: "Ad candidates eligible",
              value: tally(candidates?.eligiblePreCapCount),
            },
            {
              label: "Ad candidates served",
              value: tally(candidates?.preCapCount),
            },
          ],
          observedAt: model.source?.computedAt ?? null,
        };
      })(),
      /*
       * 12 · recommendations — the decisions this account has been given, and
       * the control that responds to them.
       *
       * WP9 names Recommendations/respond as one of its nine sections and it
       * has never been composed: `IntelligenceView` accepted an `onRespond`
       * prop and the page never passed one, so the control WP9 asks to gate had
       * nothing to gate. The read is the same snapshot the Decision Center
       * serves from, and the observation instant is the snapshot's own — never
       * this module's clock.
       */
      (async () => {
        const model = await readLatestMetaDecisionSnapshot({
          businessId,
          startDate,
          endDate,
        }).catch(() => null);
        const nothingToRespondTo = (reason: string) =>
          /*
           * The actor's refusal outranks this one.
           *
           * A reviewer told "there is nothing to respond to" would be told the
           * wrong thing: they may not respond to anything, ever, and that is
           * the sentence the route would answer with. Only when the actor MAY
           * act does the absence of a subject become the reason.
           */
          control.enabled
            ? {
                kind: "respond" as const,
                enabled: false,
                refusalCode: null,
                refusalMessage: reason,
                targets: [],
              }
            : { kind: "respond" as const, ...control, targets: [] };

        if (!model) {
          const reason =
            "No decision snapshot has been written for this window, so there is nothing to respond to yet.";
          return {
            facts: [],
            unavailableReason: reason,
            observedAt: null,
            /*
             * Refused, not offered. This branch used to leave the control
             * ENABLED with no subject: the wrapper reported itself available
             * while the action select was disabled because there was nothing
             * to aim it at, which is a control that looks usable and is not.
             */
            control: nothingToRespondTo(reason),
          } satisfies SectionOutcome;
        }
        /*
         * The ids, carried rather than counted away.
         *
         * This read already held every recommendation and kept only
         * `.length`, so the control WP9 asks for had nothing real to act on
         * and the view said "open Decision Center" instead — which is not a
         * gated action, it is a redirection. These are the same `rec_id`
         * values `/api/meta/recommendations/respond` writes, so responding
         * here records against a recommendation that exists.
         */
        const targets = model.recommendations
          .map((recommendation) => ({
            recId: asServedText(recommendation.id) ?? "",
            label:
              asServedText(recommendation.title) ??
              asServedText(recommendation.decision) ??
              "Untitled recommendation",
          }))
          .filter((target) => target.recId.length > 0);
        return {
          facts: [
            { label: "Recommendations", value: count(model.recommendations) },
            { label: "Snapshot date", value: asServedText(model.snapshotDate) ?? "Not recorded" },
          ],
          observedAt: model.snapshotCreatedAt ?? model.snapshotDate ?? null,
          /*
           * A snapshot that served no recommendation leaves the control with
           * nothing to act on, and that is a §9.1 refusal in its own right —
           * not a disabled button with no sentence, and not an instruction to
           * go somewhere else.
           */
          control:
            targets.length > 0
              ? { kind: "respond" as const, ...control, targets }
              : nothingToRespondTo(
                  "This snapshot served no recommendations, so there is nothing to respond to.",
                ),
        } satisfies SectionOutcome;
      })(),

      /*
       * 13 · snapshot — when the engine last wrote, and the control that asks
       * it to write again.
       *
       * It has no read model of its own: its facts come from the same snapshot
       * read above, and its substance is the control's state. Nothing here
       * requests a refresh — a render that triggered a snapshot run would make
       * opening a page a write.
       */
      (async () => {
        const model = await readLatestMetaDecisionSnapshot({
          businessId,
          startDate,
          endDate,
        }).catch(() => null);
        return {
          facts: [
            {
              label: "Last snapshot",
              value: asServedText(model?.snapshotDate ?? null) ?? "Never run",
            },
            {
              label: "Written at",
              value: asServedText(model?.snapshotCreatedAt ?? null) ?? "Not recorded",
            },
          ],
          observedAt: model?.snapshotCreatedAt ?? null,
          control: { kind: "run-snapshot" as const, ...control },
        } satisfies SectionOutcome;
      })(),

    ]);

  // Each row carries its own authority's observation time. There is deliberately
  // no page-wide "observed" value to pass in here: one clock shared across eight
  // sources is what made a never-synced source read as observed just now.
  const sections: IntelligenceSection[] = [
    section("status", "Connection & account", status),
    section("pulse", "Account pulse", pulse),
    section("summary", "Summary", summary),
    section("trends", "Trends", trends),
    section("breakdowns", "Breakdowns", breakdowns),
    section("anomalies", "Anomalies", anomalies),
    section("labels", "Campaign labels", labels),
    /*
     * "Structure", not "Structure & recommendations". The label asserted
     * coverage of the plan's recommendations item that this row never provided;
     * there is a real recommendations section below now, and the two would
     * otherwise both claim it.
     */
    section("structure", "Structure configuration", workspace),
    section("top-creatives", "Top creatives", topCreatives),
    section("page-status", "Page status", pageStatus),
    section("lane-classify", "Lane classify", laneClassify),
    /*
     * The two WP9 named and the composition never had. Thirteen rows now, of
     * which nine are the plan's nine.
     */
    section("recommendations", "Recommendations", recommendations),
    section("snapshot", "Snapshot run", snapshotRun),
  ];

  return { providerAccountId, sections, unavailableReason: null };
}

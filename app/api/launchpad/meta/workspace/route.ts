/**
 * One read for everything Launchpad needs at first load.
 *
 * The surface was measured at 18 API requests on first load against a budget of
 * 12, and the count had been recorded with the cause "unattributed". Naming the
 * requests answered it: nine belong to the SHELL — session, integrations,
 * billing, notifications, provider statuses, instrumentation — and are the same
 * nine every Meta surface pays. The other nine were Launchpad's own, and seven
 * of them asked the same question at the same instant, in the same tenant and
 * account scope, with the same authorization:
 *
 *   /api/meta/history/accounts        which accounts may this business use
 *   /api/launchpad/meta/templates     the manual template library
 *   /api/launchpad/meta/templates/recent
 *   /api/launchpad/meta/drafts        saved drafts
 *   /api/launchpad/meta/intents       launch-intent receipts
 *   /api/launchpad/meta/recent-ad-actions
 *   /api/business-commercial-settings the target CPA the wizard prefills with
 *
 * This is those seven, composed. It is the same pattern
 * `/api/meta/decisions-workspace` already uses for the Decision Center, and for
 * the same reason: a screen that needs seven facts to draw one view should ask
 * one question.
 *
 * ## What is NOT changed by composing
 *
 * **Scope.** Every section resolves through the same
 * `resolveAssignedMetaLaunchAccount` the standalone routes call, so a caller
 * cannot reach an account the individual routes would refuse. The accounts
 * list is business-scoped and resolves BEFORE the account, because a business
 * with two assigned accounts and none selected still has to be offered the
 * choice — that was already true and is why the account blocker cannot fail the
 * whole response.
 *
 * **Freshness.** Every route folded in here is `force-dynamic` with no cache,
 * and so is this. Nothing is served from a store that the standalone routes
 * would not have read at the same instant.
 *
 * **Authorization.** The seven routes do NOT share one floor, and this does not
 * give them one. `/api/meta/history/accounts` admits a `guest`; the six
 * Launchpad routes are hardcoded to `collaborator` by
 * `requireLaunchpadBusinessAccess`. Both floors are enforced here separately,
 * so a guest still reads the account list and still cannot read the library —
 * exactly what they could and could not do before. Collapsing them to the
 * higher floor would have taken the account picker away from a guest, and to
 * the lower floor would have handed them the library. The standalone routes are
 * untouched and still enforce their own floor on their own authority; this is a
 * second caller of the same functions, not a bypass.
 *
 * **Capability.** The store-capability reads that make an unmigrated schema
 * answer "not readable" rather than "empty" are preserved per section, because
 * an empty list and an unavailable table are different facts and §9 exists to
 * keep them apart.
 *
 * ## Failure is per section
 *
 * `Promise.allSettled`, and every section reports its own outcome. One failing
 * read must not blank six that succeeded — that is the same law the Automation
 * control plane's `sections` envelope encodes, and this envelope is shaped like
 * it deliberately.
 *
 * Nothing here reaches a provider. Every read is a table in this database.
 */
import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import { requireLaunchpadBusinessAccess } from "../route-utils";
import {
  metaLaunchAccountBlockerHttpStatus,
  resolveAssignedMetaLaunchAccount,
} from "@/lib/launchpad/meta-validation";
import {
  listManualMetaLaunchTemplates,
  listMetaLaunchDrafts,
  listRecentMetaLaunchTemplates,
} from "@/lib/launchpad/meta-store";
import { listMetaLaunchIntents } from "@/lib/launchpad/meta-launch-intent-store";
import { getMetaLaunchStoreCapability } from "@/lib/launchpad/meta-store-capability";
import { getMetaLaunchIntentCapability } from "@/lib/launchpad/meta-launch-intent-capability";
import { readRecentLaunchpadAdActions } from "@/lib/launchpad/meta-recent-ad-actions";
import {
  readMetaHistoryAccounts,
  readMetaHistoryAssignedAccountIds,
} from "@/lib/meta/history-read-model";
import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";

export const dynamic = "force-dynamic";

/** One section's outcome, in the vocabulary the surface already reports in. */
export interface LaunchpadWorkspaceSection {
  status: "complete" | "unavailable";
  /** The server's own code when it failed. Null on success. */
  errorCode: string | null;
  /** The instant the read was ATTEMPTED — stamped for failures too. */
  observedAt: string;
}

type SectionKey =
  | "accounts"
  | "templates"
  | "recentTemplates"
  | "drafts"
  | "intents"
  | "recentAdActions"
  | "targetCpa";

/** The six sections the `collaborator` floor governs. */
const LIBRARY_SECTIONS = [
  "templates",
  "recentTemplates",
  "drafts",
  "intents",
  "recentAdActions",
  "targetCpa",
] as const satisfies ReadonlyArray<SectionKey>;

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  if (!businessId) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "missing_business_id", message: "businessId is required." },
      },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  /*
   * The accounts floor first, because it is the lower one. This is the same
   * call `/api/meta/history/accounts` makes, so a guest reaches exactly the
   * same answer through this route as through that one.
   */
  const accountsAccess = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in accountsAccess) return accountsAccess.error;

  const observedAt = new Date().toISOString();
  const sections: Partial<Record<SectionKey, LaunchpadWorkspaceSection>> = {};
  const complete = (key: SectionKey) => {
    sections[key] = { status: "complete", errorCode: null, observedAt };
  };
  const unavailable = (key: SectionKey, errorCode: string) => {
    sections[key] = { status: "unavailable", errorCode, observedAt };
  };

  /*
   * The accounts list first, and business-scoped.
   *
   * It is the set `resolveAssignedMetaLaunchAccount` authorizes against, so
   * reading it cannot widen scope — and it has to answer even when no account
   * resolves, or a business with two assigned accounts is told to select one
   * with nothing to select.
   */
  const scopedBusinessId = accountsAccess.membership.businessId;
  let accounts: Awaited<ReturnType<typeof readMetaHistoryAccounts>> = [];
  try {
    const [all, assigned] = await Promise.all([
      readMetaHistoryAccounts(scopedBusinessId),
      readMetaHistoryAssignedAccountIds(scopedBusinessId),
    ]);
    const currentlyAssigned = new Set(assigned);
    accounts = all.filter((entry: { id: string }) => currentlyAssigned.has(entry.id));
    complete("accounts");
  } catch {
    unavailable("accounts", "meta_history_accounts_unavailable");
  }

  /*
   * The Launchpad floor, separately. A viewer below `collaborator` gets the
   * account list and a named refusal for the six library sections — never an
   * empty library, which is the same fact §9 keeps apart everywhere else.
   */
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) {
    for (const key of LIBRARY_SECTIONS) unavailable(key, "capability_read_denied");
    return NextResponse.json(
      { ok: true, accounts, sections },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.businessId,
    providerAccountId: request.nextUrl.searchParams.get("providerAccountId"),
  });
  if (!account.ok) {
    /*
     * A 200 carrying the blocker, not a 4xx.
     *
     * The individual routes each answered 4xx here, and the surface read seven
     * of those and inferred one state from them. The blocker is a fact about
     * the ACCOUNT, and the accounts list — which is what the operator needs in
     * order to resolve it — read fine. Failing the whole response would take
     * away the only thing that could fix it.
     */
    return NextResponse.json(
      {
        ok: true,
        accounts,
        sections,
        accountBlocker: {
          code: account.blocker.code,
          message: account.blocker.message,
          httpStatus: metaLaunchAccountBlockerHttpStatus(account.blocker.code),
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const scope = {
    businessId: access.businessId,
    providerAccountId: account.providerAccountId,
  };

  const [
    templateCapability,
    draftCapability,
    intentCapability,
  ] = await Promise.all([
    getMetaLaunchStoreCapability("templates").catch(() => null),
    getMetaLaunchStoreCapability("drafts").catch(() => null),
    getMetaLaunchIntentCapability().catch(() => null),
  ]);

  const [templates, recentTemplates, drafts, intents, recentAdActions, commercial] =
    await Promise.allSettled([
      templateCapability?.canRead === false
        ? Promise.resolve([])
        : listManualMetaLaunchTemplates(scope),
      templateCapability?.canRead === false
        ? Promise.resolve([])
        : listRecentMetaLaunchTemplates(scope),
      draftCapability?.canRead === false
        ? Promise.resolve([])
        : listMetaLaunchDrafts(scope),
      intentCapability?.canRead === false
        ? Promise.resolve([])
        : listMetaLaunchIntents({
            ...scope,
            limit: Number(request.nextUrl.searchParams.get("limit") ?? 12),
          }),
      readRecentLaunchpadAdActions(scope),
      getBusinessCommercialTruthSnapshot(access.businessId),
    ]);

  const settled = <T,>(
    key: SectionKey,
    result: PromiseSettledResult<T>,
    errorCode: string,
    fallback: T,
  ): T => {
    if (result.status === "fulfilled") {
      complete(key);
      return result.value;
    }
    unavailable(key, errorCode);
    return fallback;
  };

  const targetPack =
    commercial.status === "fulfilled"
      ? (commercial.value as { targetPack?: { targetCpa?: unknown } | null } | null)
          ?.targetPack
      : null;
  if (commercial.status === "fulfilled") complete("targetCpa");
  else unavailable("targetCpa", "commercial_truth_unavailable");

  return NextResponse.json(
    {
      ok: true,
      providerAccountId: account.providerAccountId,
      accounts,
      sections,
      capability: {
        templates: templateCapability,
        drafts: draftCapability,
        intents: intentCapability,
      },
      templates: settled("templates", templates, "templates_failed", []),
      recentTemplates: settled(
        "recentTemplates",
        recentTemplates,
        "recent_templates_failed",
        [],
      ),
      drafts: settled("drafts", drafts, "drafts_failed", []),
      intents: settled("intents", intents, "launch_intents_failed", []),
      recentAdActions: settled(
        "recentAdActions",
        recentAdActions,
        "recent_ad_actions_failed",
        [],
      ),
      // Read, never derived. A target CPA that is not a positive finite number
      // is absent rather than zero.
      targetCpa: isFinitePositive(targetPack?.targetCpa)
        ? targetPack.targetCpa
        : null,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

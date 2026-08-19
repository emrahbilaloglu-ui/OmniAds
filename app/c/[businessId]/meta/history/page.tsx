import { notFound, redirect } from "next/navigation";

import { listUserBusinesses } from "@/lib/access";
import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import {
  readMetaHistoryAccounts,
  readMetaHistoryAssignedAccountIds,
  readMetaHistoryJournal,
} from "@/lib/meta/history-read-model";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import { resolveProviderAccountId } from "@/lib/zero-base/provider-scope-server";
import { toHistoryPage } from "@/lib/zero-base/meta/history-adapter";
import { resolveHistoryDateWindow } from "@/lib/meta/history-date-window";
import { getTodayIsoForTimeZone } from "@/lib/dashboard/date-window-presets";
import { HistoryAccountPicker } from "@/components/zero-base/meta/history/history-account-picker";
import { HistoryClient } from "@/components/zero-base/meta/history/history-client";
import { HistoryView } from "@/components/zero-base/meta/history/history-view";

export const dynamic = "force-dynamic";

const PAGE_LIMIT = 40;

function first(value: string | string[] | undefined) {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return null;
}

/** The raw `searchParams` record as the `.get()` shape the date authority reads. */
function toSearchParams(
  raw: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") search.append(key, value);
    else if (Array.isArray(value)) for (const item of value) search.append(key, item);
  }
  return search;
}

/**
 * The window this page measures — read through the shared authority, never
 * re-derived here.
 *
 * ITEM 12 in one sentence: the date control at the top of the screen is the
 * question, and this route now answers that question for every URL shape rather
 * than only for the one the shell happens to write.
 *
 * The rule and the reasons live in `lib/meta/history-date-window.ts`. What is
 * worth stating at the call site is the clock: `getTodayIsoForTimeZone` on the
 * WORKSPACE timezone is the exact expression `components/layout/v2/app-topbar.tsx`
 * evaluates to resolve its own presets, read from the same `businesses.timezone`
 * column. A rolling preset expanded against the server's zone instead would move
 * the window a day for any workspace east or west of UTC near the boundary —
 * TheSwaf runs on America/New_York, so that is a live skew, not a hypothetical.
 *
 * The previous version of this function is gone rather than extended. It read
 * exact dates and refused everything else, because the shared expansion was
 * re-exported from a `"use client"` module and calling it from a Server
 * Component threw "Attempted to call getPresetDatesForReferenceDate() from the
 * server" (observed on this route, dev digest 3202480149). That constraint no
 * longer exists: `lib/dashboard/date-window-presets.ts` has no client boundary,
 * so there is nothing left for a private expansion to work around.
 */
async function workspaceReferenceDate(input: {
  businessId: string;
  userId: string;
}): Promise<string> {
  // A failed read is not a reason to take the journal down, and it is not a
  // reason to invent a zone either: UTC is the same placeholder the topbar uses
  // before it has confirmed the workspace, so the two agree even while degraded.
  const businesses = await listUserBusinesses(input.userId).catch(() => []);
  const timeZone =
    businesses.find((item) => item.id === input.businessId)?.timezone ?? "UTC";
  return getTodayIsoForTimeZone(timeZone);
}

export default async function MetaHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/meta/history`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  // Two reads of "which accounts may this page show", kept separate on purpose.
  //
  // `readMetaHistoryAccounts` is History's own projection and is the only one
  // carrying the name, currency and timezone the surface prints.
  // `readMetaHistoryAssignedAccountIds` is the canonical assignment guard the
  // rest of the product resolves scope through. Only the intersection is
  // offered, so an identity row that outlived its deselection cannot put an
  // unassigned account back on this screen.
  //
  // Neither is allowed to fail quietly. A caught assignment error would present
  // as "no Meta account is assigned to this business" — a settled fact about
  // the configuration — when the truth is that the assignment could not be
  // read. That distinction is the whole point of the unavailable state.
  let accounts: MetaHistoryAccount[];
  let assignedAccountIds: string[];
  try {
    [accounts, assignedAccountIds] = await Promise.all([
      readMetaHistoryAccounts(businessId),
      readMetaHistoryAssignedAccountIds(businessId),
    ]);
  } catch {
    return (
      <HistoryView
        rows={[]}
        unavailableReason="The persisted Meta journal is unavailable right now."
      />
    );
  }

  const currentlyAssigned = new Set(assignedAccountIds);
  const assignedAccounts = accounts.filter((item) =>
    currentlyAssigned.has(item.id),
  );

  if (assignedAccounts.length === 0) {
    return (
      <HistoryView
        rows={[]}
        unavailableReason="No Meta account is assigned to this business, so there is no journal to read."
      />
    );
  }

  // The account the operator selected, not the first one this business happens
  // to have assigned. The shell writes the selection into the URL and the rail
  // carries it across every Meta route, so ignoring it here read account A's
  // journal while the chip above said B — and every later read (search, filter,
  // Load more, Replay) inherited that wrong scope.
  //
  // Cross-business scope is still closed: `resolveProviderAccountId` answers
  // only from this business's own assignments, refuses an id this business is
  // not assigned, and refuses to pick one of several. It can therefore only
  // narrow to an account this business already owns.
  const raw = (await searchParams) ?? {};
  const search = toSearchParams(raw);
  const dateWindow = resolveHistoryDateWindow({
    searchParams: search,
    referenceDate: await workspaceReferenceDate({
      businessId,
      userId: access.context.session.user.id,
    }),
  });
  const requestedAccountId = first(raw.providerAccountId);
  const providerAccountId = await resolveProviderAccountId({
    businessId,
    provider: "meta",
    requestedAccountId,
  });

  if (!providerAccountId) {
    // Two different refusals, because the remedies differ: an id this business
    // does not hold is a wrong link, several assigned accounts is a missing
    // choice. Neither may fall back to "whichever account sorts first" — that
    // would print one account's journal under another account's name.
    return (
      <HistoryView
        rows={[]}
        unavailableReason={
          requestedAccountId
            ? `Meta account ${requestedAccountId} is not assigned to this business, so its journal cannot be read.`
            : "Several Meta accounts are assigned to this business. Select one to read its journal."
        }
        // A choice, not a fallback. The picker offers only accounts this
        // business is currently assigned, and choosing one re-enters this route
        // so the server resolves it again — it can never widen scope. It is
        // offered only where the refusal is "which one?": a wrong id is a wrong
        // link, and a list of the right ones is not an answer to that.
        unavailableAction={
          requestedAccountId ? undefined : (
            <HistoryAccountPicker accounts={assignedAccounts} />
          )
        }
      />
    );
  }

  // Re-verified against the current assignment, not just against History's own
  // projection: a resolved id must be BOTH currently assigned and present in
  // the journal's account read, or the surface has no honest currency and name
  // to print beside its rows.
  const account =
    assignedAccounts.find((item) => item.id === providerAccountId) ?? null;
  if (!account) {
    return (
      <HistoryView
        rows={[]}
        unavailableReason={`The Meta journal could not be scoped to account ${providerAccountId}.`}
      />
    );
  }

  const payload = await readMetaHistoryJournal({
    query: {
      businessId,
      providerAccountId: account.id,
      kind: null,
      entity: null,
      label: null,
      outcome: null,
      // The shell's window is History's window — the same two dates the shared
      // authority produced above, not a second resolution of the same URL.
      // Always bounded now: an unresolvable URL resolves to the shell's own
      // default preset and the surface says so, rather than the table quietly
      // answering "everything ever recorded" under a chip naming four weeks.
      from: dateWindow.start,
      to: dateWindow.end,
      q: null,
      cursor: null,
      limit: PAGE_LIMIT,
    },
    account,
  }).catch(() => null);

  if (!payload) {
    return (
      <HistoryView
        rows={[]}
        unavailableReason="The persisted Meta journal could not be read for this account."
      />
    );
  }

  const page = toHistoryPage(payload);
  // The search, outcome filter, pager and per-row Replay controls need
  // callbacks, and a server component cannot supply one. The first page is
  // still read here so the surface renders with real rows before any client
  // code runs; the client only takes over when the operator asks for more.
  return (
    <HistoryClient
      businessId={businessId}
      providerAccountId={account.id}
      // Handed down, never re-derived: the client's refetch, its return to
      // unfiltered defaults and every "Load more" page read the same window
      // these first rows were read for.
      dateWindow={dateWindow}
      initialPage={page}
      pageLimit={PAGE_LIMIT}
    />
  );
}

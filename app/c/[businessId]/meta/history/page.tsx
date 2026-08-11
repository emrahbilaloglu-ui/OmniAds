import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import {
  readMetaHistoryAccounts,
  readMetaHistoryJournal,
} from "@/lib/meta/history-read-model";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { toHistoryPage } from "@/lib/zero-base/meta/history-adapter";
import { HistoryView } from "@/components/zero-base/meta/history/history-view";

export const dynamic = "force-dynamic";

const PAGE_LIMIT = 40;

export default async function MetaHistoryPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor(`/c/${businessId}/meta/history`));

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  // The account is resolved from this business's own assignments, and the
  // journal read is scoped to an account that read returned. A cross-business
  // account id cannot be reached from here because none is accepted from the
  // request at all.
  const accounts = await readMetaHistoryAccounts(businessId).catch(() => null);
  if (!accounts) {
    return (
      <HistoryView
        rows={[]}
        unavailableReason="The persisted Meta journal is unavailable right now."
      />
    );
  }
  if (accounts.length === 0) {
    return (
      <HistoryView
        rows={[]}
        unavailableReason="No Meta account is assigned to this business, so there is no journal to read."
      />
    );
  }

  const assignment = await getProviderAccountAssignments(businessId, "meta").catch(() => null);
  const account =
    accounts.find((item) => assignment?.account_ids?.includes(item.id)) ?? accounts[0];

  const payload = await readMetaHistoryJournal({
    query: {
      businessId,
      providerAccountId: account.id,
      kind: null,
      entity: null,
      label: null,
      from: null,
      to: null,
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
  return (
    <HistoryView
      rows={page.rows}
      disclosure={page.disclosure}
      limitations={page.limitations}
      accountLabel={page.accountLabel}
    />
  );
}

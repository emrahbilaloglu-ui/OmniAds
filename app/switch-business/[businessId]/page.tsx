import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies, setSessionActiveBusiness } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { sanitizeNextPath } from "@/lib/auth-routing";
import {
  AGENCY_RETURN_PARAM,
  parseAgencyReturn,
} from "@/lib/workspace/agency-return";

export const dynamic = "force-dynamic";

export default async function SwitchBusinessPage({
  params,
  searchParams,
}: {
  params: Promise<{ businessId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;
  const query = await searchParams;
  const raw = query?.next;
  const requested = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : null;
  // `sanitizeNextPath` is what keeps this safe: it resolves the value and proves
  // the origin did not move, so a post-authentication open redirect cannot get
  // through. The extra `/app/` narrowing on top of it was a surface preference,
  // not a security control, and it quietly overrode every caller that asked for
  // a dashboard path — `select-business` asks for `/overview` and landed on
  // `/app/home` regardless. A sanitized local path is now honoured as asked.
  const baseDestination = sanitizeNextPath(requested) ?? "/overview";
  const rawReturn = query?.[AGENCY_RETURN_PARAM];
  const requestedReturn =
    typeof rawReturn === "string" ? rawReturn : Array.isArray(rawReturn) ? rawReturn[0] : null;
  const agencyReturn = parseAgencyReturn(requestedReturn);
  const destination = agencyReturn
    ? `${baseDestination}${baseDestination.includes("?") ? "&" : "?"}${AGENCY_RETURN_PARAM}=${encodeURIComponent(requestedReturn!)}`
    : baseDestination;

  const session = await getSessionFromCookies();
  if (!session) {
    const resume = new URLSearchParams({ next: baseDestination });
    if (agencyReturn && requestedReturn) resume.set(AGENCY_RETURN_PARAM, requestedReturn);
    redirect(
      `/login?next=${encodeURIComponent(`/switch-business/${encodeURIComponent(businessId)}?${resume.toString()}`)}`,
    );
  }

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") notFound();

  if (session.activeBusinessId !== businessId) {
    await setSessionActiveBusiness(session.sessionId, businessId);
  }
  redirect(destination);
}

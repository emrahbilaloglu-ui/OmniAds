import { NextRequest, NextResponse } from "next/server";

import { getSessionFromCookies, setSessionActiveBusiness } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { sanitizeNextPath } from "@/lib/auth-routing";
import {
  AGENCY_RETURN_PARAM,
  parseAgencyReturn,
} from "@/lib/workspace/agency-return";

export const dynamic = "force-dynamic";

/**
 * A business switch is a navigation boundary: the next document must be read
 * under the newly selected session. The former Server Component wrote that
 * session and then streamed a redirect. A cross-business /c/Decisions arrival
 * reproduced React #310 in App Router before its workspace request. This
 * handler makes this hop an HTTP redirect after the session write, so it does
 * not stream an intermediate page under two different scopes.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ businessId: string }> },
) {
  const { businessId } = await params;
  const query = request.nextUrl.searchParams;
  const baseDestination = sanitizeNextPath(query.get("next")) ?? "/overview";
  const requestedReturn = query.get(AGENCY_RETURN_PARAM);
  const agencyReturn = parseAgencyReturn(requestedReturn);
  const destination = agencyReturn
    ? `${baseDestination}${baseDestination.includes("?") ? "&" : "?"}${AGENCY_RETURN_PARAM}=${encodeURIComponent(requestedReturn!)}`
    : baseDestination;

  const session = await getSessionFromCookies();
  if (!session) {
    const resume = new URLSearchParams({ next: baseDestination });
    if (agencyReturn && requestedReturn) resume.set(AGENCY_RETURN_PARAM, requestedReturn);
    const login = `/login?next=${encodeURIComponent(`/switch-business/${encodeURIComponent(businessId)}?${resume.toString()}`)}`;
    return switchRedirect(request, login);
  }

  const access = await requireBusinessPageContext({ businessId });
  if (access.kind !== "ok") {
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" },
    });
  }

  if (session.activeBusinessId !== businessId) {
    await setSessionActiveBusiness(session.sessionId, businessId);
  }
  return switchRedirect(request, destination);
}

function switchRedirect(request: NextRequest, destination: string): NextResponse {
  const response = NextResponse.redirect(new URL(destination, request.url));
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Vary", "Cookie");
  return response;
}

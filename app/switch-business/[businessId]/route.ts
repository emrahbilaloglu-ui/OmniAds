import { NextRequest, NextResponse } from "next/server";

import { getSessionFromCookies } from "@/lib/auth";
import { requireBusinessPageContext } from "@/lib/access/require-business-page-context";
import { sanitizeNextPath } from "@/lib/auth-routing";
import { publicRedirectBaseUrl } from "@/lib/public-redirect-url";
import {
  AGENCY_RETURN_PARAM,
  parseAgencyReturn,
} from "@/lib/workspace/agency-return";

export const dynamic = "force-dynamic";

/**
 * A business switch is a navigation boundary. A GET must not write session
 * state (including when a link is prefetched). If the target differs, send a
 * no-store HTTP redirect to a completion page that uses the authenticated
 * POST switch endpoint, then makes a full document navigation. This avoids
 * the old Server Component's write followed by a streamed redirect.
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

  if (session.activeBusinessId === businessId) {
    return switchRedirect(request, destination);
  }
  const completion = `/switch-business/${encodeURIComponent(businessId)}/finish?next=${encodeURIComponent(destination)}`;
  return switchRedirect(request, completion);
}

function switchRedirect(request: NextRequest, destination: string): NextResponse {
  const response = NextResponse.redirect(new URL(destination, publicRedirectBaseUrl(request)));
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Vary", "Cookie");
  return response;
}

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import {
  SHOPIFY_INSTALL_PROOF_COOKIE,
  readShopifyInstallContextForViewer,
} from "@/lib/shopify/install-context-access";

/**
 * GET /api/oauth/shopify/context?token=...
 *
 * Read the pending Shopify install the signed-in caller is allowed to see.
 *
 * This was an unauthenticated read: any holder of a context token — a URL from
 * a history entry, a `?next=` parameter, a pasted link — got another tenant's
 * shop domain, shop name, currency, install timestamps and the business the
 * install was started for, repeatedly, until the token expired. Every check now
 * lives in `lib/shopify/install-context-access.ts`; this handler only supplies
 * the request's identity and turns one internal outcome into one HTTP shape.
 *
 * The refusal is deliberately uniform. Expired, unknown, someone else's, or for
 * a business the caller cannot finish the install into are all the same 404
 * body: a caller who does not own a token must not be able to learn from the
 * response whether it exists. The one status that differs is 401, and it is
 * returned before the token is looked at at all, so it discloses nothing about
 * it.
 */
const REFUSAL_BODY = {
  error: "context_not_found",
  message: "Shopify install context not found or expired.",
} as const;

function noStore(response: NextResponse) {
  // A pending install is per-browser and per-session. Nothing between here and
  // the merchant may keep a copy to hand to the next caller.
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

export async function GET(request: NextRequest) {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return noStore(
      NextResponse.json(
        { error: "auth_error", message: "Authentication required." },
        { status: 401 },
      ),
    );
  }

  const result = await readShopifyInstallContextForViewer({
    token: request.nextUrl.searchParams.get("token") ?? "",
    sessionId: session.sessionId,
    userId: session.user.id,
    userEmail: session.user.email,
    installProof: request.cookies.get(SHOPIFY_INSTALL_PROOF_COOKIE)?.value ?? null,
  });

  if (!result.ok) {
    // The reason is not echoed: it distinguishes cases the caller is not
    // entitled to distinguish. The token is not logged either — it is a live
    // credential address, and logs outlive the 30-minute window it is useful in.
    return noStore(NextResponse.json(REFUSAL_BODY, { status: 404 }));
  }

  return noStore(NextResponse.json({ context: result.context }));
}

import { NextRequest, NextResponse } from "next/server";

/**
 * Klaviyo has no real OAuth integration. This endpoint previously fabricated a
 * "connected" integration record (upsertIntegration with a synthetic account id) and
 * redirected back with status=success — a fake handshake that made the UI claim Klaviyo
 * was connected when nothing real happened.
 *
 * That violated the honesty rule ("make it work with a real backend or remove — never
 * fake"). Until a genuine Klaviyo OAuth flow exists, this route refuses to fabricate a
 * connection and reports the honest not-implemented boundary. The Integrations UI no
 * longer links here (Klaviyo renders as a "coming soon" provider).
 */
export function GET(_request: NextRequest) {
  return NextResponse.json(
    {
      error: "not_implemented",
      message:
        "Klaviyo does not have a live OAuth integration yet. A real authorization flow must be built before Klaviyo can be connected.",
    },
    { status: 501 },
  );
}

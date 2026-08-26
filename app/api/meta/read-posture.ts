/**
 * The read-side refusal for a workspace whose posture cannot be established.
 *
 * The write boundary (`demo-write-authority`) already refuses an unverified
 * workspace. A READ route had no equivalent: it asked
 * `lib/business-mode.server.isDemoBusiness`, which manufactures `false` — live —
 * from a database it could not read, and then called a provider and served the
 * answer as fact for a workspace nobody had confirmed was real.
 *
 * This is the same refusal in the read direction. 503 rather than 4xx, and the
 * same status the write boundary uses for the same cause: the workspace is not
 * being rejected, the source could not be established, and a client that shows
 * it should show "unavailable" rather than "empty".
 */
import { NextResponse } from "next/server";
import { META_POSTURE_UNVERIFIED_REASON } from "@/lib/meta/business-data-posture";

export function metaPostureUnavailable(surface: string): NextResponse {
  return NextResponse.json(
    {
      error: "workspace_posture_unverified",
      message: META_POSTURE_UNVERIFIED_REASON,
      surface,
      // The read-model envelopes carry these two, so a caller that renders the
      // envelope rather than the status code still says "not ready" instead of
      // drawing an empty screen as though the account had no activity.
      isPartial: true,
      notReadyReason: META_POSTURE_UNVERIFIED_REASON,
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

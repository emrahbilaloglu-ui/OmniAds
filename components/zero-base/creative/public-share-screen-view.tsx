"use client";

/**
 * One `screen_view` from the public creative share, carrying no identifier.
 *
 * The contracted leaf `share_creative` describes an
 * *"Unauthenticated recipient · token scope only"*, and it emitted nothing at
 * all until now: the generator derived `anonymous` from a `Public · pre-auth`
 * prefix, so this leaf came out `anonymous: false` and the ingest refused the
 * very page the ledger records as live.
 *
 * ## What it does not send
 *
 * No business id, no user id, no token, no token HASH, no address, no title and
 * no free text. That is stricter than the contracted property list, which
 * permits `token_hash` — and the omission is deliberate. A stable hash of the
 * link is a stable identifier FOR the link: it makes every open of one share
 * joinable, which turns an anonymous page view into a behavioural record of one
 * named recipient. Counting that a share was opened does not require knowing
 * which share.
 *
 * The event therefore carries what the server derives and nothing else — the
 * surface, the time, an anonymous actor role and a viewport bucket.
 *
 * ## Why only the success branch mounts it
 *
 * `PublicShareUnavailable` renders for a token that is invalid, malformed,
 * expired, revoked or rotated away — deliberately the same view for all five,
 * so a caller cannot tell them apart. An event fired from that branch would
 * confirm that a request reached a real page, which is exactly the distinction
 * the shared view exists to withhold. So this is mounted by the served page and
 * by nothing else.
 */
import { useEffect, useRef } from "react";

import { emitScreenView } from "@/lib/zero-base/instrumentation-client";

export function PublicShareScreenView() {
  // Once per mount, not once per render. React may run an effect twice in
  // development, and a doubled adoption number was the exact defect the shell
  // emitter had to fix.
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void emitScreenView({ surface: "share_creative" });
  }, []);

  return null;
}

/**
 * The report-share disabled state, defined once for both entry points.
 *
 * The zero-base design removes the mint control from the report UI, so the
 * final behavior of the two surviving endpoints is to refuse. That refusal is
 * implemented behind `ZERO_BASE_REPORT_SHARE_FAIL_CLOSED`, which defaults to
 * false: an already-deployed sharing capability must not disappear as a side
 * effect of shipping the new UI. Turning it on in any deployed environment
 * needs written operator authority, including a decision about tokens that
 * have already been issued.
 *
 * Both branches must hold at once:
 *
 * - flag off — the endpoint and the public page behave exactly as before;
 * - flag on  — nothing is minted and nothing is read, and the public page's
 *   response cannot vary by token. That last part is why the guard runs before
 *   the token is even looked at: a timing or content difference between a real
 *   and a fake token would still be an oracle.
 *
 * No stored snapshot is deleted in either branch.
 */
import { readZeroBaseRolloutConfig } from "@/lib/zero-base/rollout";

export const REPORT_SHARE_DISABLED_ERROR = "report_share_disabled";

/** Stable body. Identical for every caller, role, report and token. */
export const REPORT_SHARE_DISABLED_RESPONSE = {
  error: REPORT_SHARE_DISABLED_ERROR,
  message: "Report sharing is unavailable.",
  prerequisites: [
    "Report sharing is disabled for this workspace.",
    "Existing share links are unaffected by this request.",
  ],
} as const;

/** Prerequisite-not-met rather than a permission error: no role satisfies it. */
export const REPORT_SHARE_DISABLED_STATUS = 409;

export function isReportShareFailClosed(env: NodeJS.ProcessEnv = process.env): boolean {
  return readZeroBaseRolloutConfig(env).reportShareFailClosed;
}

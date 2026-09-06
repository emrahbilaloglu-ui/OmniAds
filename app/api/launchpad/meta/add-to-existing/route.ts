import { NextRequest } from "next/server";
import { handleMetaAddToExistingAction } from "@/lib/launchpad/meta-launch-route-handlers";

export const dynamic = "force-dynamic";

/**
 * No options, and that is not the same as no pre-POST boundary.
 *
 * The handler composes the approval-standing check itself
 * (`mandatoryProviderMutationBoundary`); the options object exists for callers
 * that hold a claim of their own — the Automation queue's dispatch marker —
 * and it is an ADDITIONAL requirement, never a replacement.
 */
export async function POST(request: NextRequest) {
  return handleMetaAddToExistingAction(request);
}

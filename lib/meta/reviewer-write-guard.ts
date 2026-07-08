import { NextResponse } from "next/server";
import { isReviewerEmail } from "@/lib/reviewer-access";

interface ReviewerWriteAccess {
  session: {
    user: {
      email?: string | null;
    };
  };
}

export function reviewerReadOnlyError(action?: string) {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "reviewer_read_only",
        message: "Reviewer access is read-only; write actions are unavailable for this workspace.",
        ...(action ? { action } : {}),
      },
    },
    { status: 403 },
  );
}

export function rejectIfReviewerReadOnly(
  access: ReviewerWriteAccess,
  action?: string,
): NextResponse | null {
  return isReviewerEmail(access.session.user.email) ? reviewerReadOnlyError(action) : null;
}

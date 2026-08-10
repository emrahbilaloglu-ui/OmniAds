"use client";

import { useEffect } from "react";

/**
 * Share error boundary.
 *
 * Share links are opened by clients and creators, not by operators. A render
 * failure here previously fell through to Next's unstyled crash screen on a
 * page that is meant to be a polished client deliverable.
 *
 * Unlike the admin boundary, this deliberately shows no internal detail: the
 * viewer is outside the workspace, cannot act on a stack trace, and an error
 * message can carry account names, ids or query fragments. The cause goes to
 * the console for the operator who owns the link.
 */
export default function ShareError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[share-error]", {
      name: error.name,
      digest: error.digest ?? null,
    });
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-lg font-semibold text-neutral-900">This report is unavailable</h1>
      <p className="text-sm text-neutral-600">
        The link could not be opened right now. It may have expired, or the report may still be
        generating. Ask whoever shared it to send a fresh link if this continues.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
      >
        Try again
      </button>
    </main>
  );
}

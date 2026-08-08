/**
 * What to tell an operator when a Meta workspace read fails.
 *
 * The routes already answer with a specific, actionable reason — an account
 * that is not assigned to this business, a scope that could not be verified —
 * and the surface used to discard it and say "unavailable". An operator who is
 * told the workspace is unavailable waits; an operator who is told the account
 * is not assigned goes and assigns it. Only the second one is true here.
 *
 * A synthesised status line ("Request failed (500)") is not a reason and is
 * deliberately not promoted into one.
 */
export class MetaRequestFailure extends Error {
  readonly status: number;
  /** True only when the server sent a human-readable reason of its own. */
  readonly hasServerReason: boolean;

  constructor(input: {
    message: string;
    status: number;
    hasServerReason: boolean;
  }) {
    super(input.message);
    this.name = "MetaRequestFailure";
    this.status = input.status;
    this.hasServerReason = input.hasServerReason;
  }
}

export const WORKSPACE_UNAVAILABLE_FALLBACK =
  "Decision workspace unavailable - counts are withheld";

export function describeDecisionWorkspaceFailure(
  error: unknown,
): string {
  if (
    error instanceof MetaRequestFailure &&
    error.hasServerReason &&
    error.message.trim().length > 0
  ) {
    return `Decisions withheld - ${error.message.trim()}`;
  }
  return WORKSPACE_UNAVAILABLE_FALLBACK;
}

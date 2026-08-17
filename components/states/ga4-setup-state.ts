/**
 * The difference between "this broke" and "this is not set up yet".
 *
 * `GA4AuthError` has always carried an `action` — `connect_ga4`,
 * `select_property`, `reconnect_ga4`, `retry_later` — that names the ONE thing
 * that resolves it. The screens then rendered every one of them through the
 * generic `ErrorState`, whose title is "Something went wrong" and whose only
 * control is Retry. On a workspace with GA4 connected and no property selected
 * (Grandmix, verified in production) the Analytics tab therefore announced a
 * crash and offered a button that can never fix it, with the real remedy buried
 * in the description sentence.
 *
 * A configuration state is not a failure. This maps the three actionable
 * `action` values onto the empty-state the screens already use for "GA4 is not
 * connected" — same visual language, and a control that goes where the fix
 * actually lives. `retry_later` is the one action a Retry CAN resolve, so it is
 * deliberately not mapped here and keeps the error card.
 */

export type Ga4ErrorAction =
  | "connect_ga4"
  | "select_property"
  | "reconnect_ga4"
  | "retry_later";

const GA4_ERROR_ACTIONS = new Set<string>([
  "connect_ga4",
  "select_property",
  "reconnect_ga4",
  "retry_later",
]);

/**
 * Error codes that mean the same thing as the actions above, for the routes
 * that answer with `error` but drop `action`. Keyed on the code so a route that
 * has not been taught to forward the action is still read correctly rather than
 * mis-announced as a crash.
 */
const CODE_TO_ACTION: Record<string, Ga4ErrorAction> = {
  ga4_not_connected: "connect_ga4",
  integration_not_found: "connect_ga4",
  no_property_selected: "select_property",
  integration_malformed: "select_property",
  token_expired: "reconnect_ga4",
  token_refresh_failed: "reconnect_ga4",
  missing_access_token: "reconnect_ga4",
};

export interface Ga4ActionableError extends Error {
  code?: string;
  action?: Ga4ErrorAction;
  reconnectRequired?: boolean;
}

/** The action this error names, from the field or — failing that — the code. */
export function readGa4ErrorAction(error: unknown): Ga4ErrorAction | null {
  if (!(error instanceof Error)) return null;
  const typed = error as Ga4ActionableError;
  if (typeof typed.action === "string" && GA4_ERROR_ACTIONS.has(typed.action)) {
    return typed.action;
  }
  if (typeof typed.code === "string" && CODE_TO_ACTION[typed.code]) {
    return CODE_TO_ACTION[typed.code]!;
  }
  return null;
}

/**
 * The server's own sentence, plus the one step that resolves it. Kept as one
 * composer so the empty state's copy and the error card's copy cannot drift.
 */
export function formatGa4ErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message?.trim() || fallback;
  switch (readGa4ErrorAction(error)) {
    case "connect_ga4":
      return `${message} Connect GA4 in Integrations to continue.`;
    case "select_property":
      return `${message} Select a GA4 property in Integrations to continue.`;
    case "reconnect_ga4":
      return `${message} Reconnect GA4 in Integrations.`;
    case "retry_later":
      return `${message} The page stopped retrying automatically to avoid consuming more GA4 quota.`;
    default:
      return message;
  }
}

export interface Ga4SetupState {
  /** What `IntegrationEmptyState` needs to draw itself. */
  status: "error" | "disconnected";
  title: string;
  description: string;
}

/**
 * The setup state this error describes, or `null` when it is a real failure and
 * belongs in the error card with its Retry.
 *
 * `surfaceLabel` names the screen being unlocked ("Analytics", "AI Visibility")
 * so the title reads like the connect-state title already on that screen.
 */
export function resolveGa4SetupState(
  error: unknown,
  input: { surfaceLabel: string; fallbackMessage: string },
): Ga4SetupState | null {
  const action = readGa4ErrorAction(error);
  if (!action || action === "retry_later") return null;

  const description = formatGa4ErrorMessage(error, input.fallbackMessage);
  switch (action) {
    case "connect_ga4":
      return {
        status: "disconnected",
        title: `Connect GA4 to unlock ${input.surfaceLabel}`,
        description,
      };
    case "select_property":
      return {
        status: "disconnected",
        title: `Select a GA4 property to unlock ${input.surfaceLabel}`,
        description,
      };
    case "reconnect_ga4":
      return {
        status: "error",
        title: `Reconnect GA4 to unlock ${input.surfaceLabel}`,
        description,
      };
  }
}

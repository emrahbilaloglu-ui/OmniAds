/**
 * Auth and onboarding states, derived from server responses.
 *
 * Every state here is a mapping of something the server already decided —
 * `/api/invite/[token]` returns `login_required`, `email_mismatch`,
 * `invite_closed`, `invite_expired` or an acceptance, each with its own status
 * code. The UI's job is to render those faithfully, not to re-derive them from
 * a message string or invent a sixth.
 *
 * The copy matters as much as the mapping. "Invite link is invalid or expired"
 * covers four different situations with four different remedies, and a user who
 * reads it cannot tell whether to log in, ask for a new invite, or check they
 * are using the right address. Each state therefore names what happened and
 * what to do about it.
 */

export type InviteState =
  /** Invite is valid and can be accepted by this visitor. */
  | "acceptable"
  /** 401 — an account already exists for the invited address. */
  | "login_required"
  /** 403 — signed in as somebody else. */
  | "email_mismatch"
  /** 409 — already accepted, revoked, or otherwise no longer pending. */
  | "invite_closed"
  /** 410 — past its expiry. */
  | "invite_expired"
  /** 404 — no such token. */
  | "not_found"
  /** 200 on POST — membership granted. */
  | "accepted";

export interface InviteStateCopy {
  title: string;
  body: string;
  /** Primary next step, or null when there is genuinely nothing to do. */
  action: { label: string; href: string } | null;
}

/**
 * Maps an invite response onto a state.
 *
 * Keyed on the error code first and the status second: the code is the
 * server's own vocabulary, and falling back to status alone would collapse
 * distinct outcomes that happen to share one.
 */
export function inviteStateFromResponse(input: {
  status: number;
  code?: string | null;
}): InviteState {
  switch (input.code) {
    case "login_required":
      return "login_required";
    case "email_mismatch":
      return "email_mismatch";
    case "invite_closed":
      return "invite_closed";
    case "invite_expired":
      return "invite_expired";
    case "not_found":
      return "not_found";
    default:
      break;
  }
  // No code: fall back to the status the server used for each case.
  switch (input.status) {
    case 200:
    case 201:
      return "accepted";
    case 401:
      return "login_required";
    case 403:
      return "email_mismatch";
    case 404:
      return "not_found";
    case 409:
      return "invite_closed";
    case 410:
      return "invite_expired";
    default:
      return "not_found";
  }
}

export function inviteStateCopy(
  state: InviteState,
  context: { invitedEmail?: string | null; signedInEmail?: string | null; token?: string } = {},
): InviteStateCopy {
  const invited = context.invitedEmail ?? "the invited address";
  const inviteHref = context.token ? `/invite/${context.token}` : "/login";

  switch (state) {
    case "acceptable":
      return {
        title: "You have been invited",
        body: `This invitation was sent to ${invited}. Accepting adds you to the business.`,
        action: null,
      };
    case "login_required":
      return {
        title: "Log in to accept",
        body: `An account already exists for ${invited}. Log in with it and this invitation will be waiting.`,
        action: { label: "Log in", href: `/login?next=${encodeURIComponent(inviteHref)}` },
      };
    case "email_mismatch":
      return {
        title: "This invitation is for a different account",
        body: context.signedInEmail
          ? `You are signed in as ${context.signedInEmail}, but this invitation was sent to ${invited}. Sign out and log in with that address.`
          : `This invitation was sent to ${invited}. Sign in with that address to accept it.`,
        action: { label: "Sign out", href: "/logout" },
      };
    case "invite_closed":
      return {
        title: "This invitation is no longer open",
        body: "It has already been accepted or was withdrawn. Ask an admin of the business to send a new one.",
        action: null,
      };
    case "invite_expired":
      return {
        title: "This invitation has expired",
        body: "Invitations are time-limited. Ask an admin of the business to send a new one.",
        action: null,
      };
    case "not_found":
      return {
        title: "This invitation link is not valid",
        body: "The link may have been mistyped or truncated. Ask an admin of the business to send it again.",
        action: null,
      };
    case "accepted":
      return {
        title: "Invitation accepted",
        body: "You now have access to the business.",
        action: null,
      };
  }
}

/* ------------------------------------------------------------------- login */

export type LoginFailureState =
  | "field_validation"
  | "invalid_credentials"
  | "rate_limited"
  | "offline"
  | "server_error";

export function loginFailureFromResponse(input: {
  status?: number;
  code?: string | null;
  /** True when the request never reached the server. */
  networkError?: boolean;
}): LoginFailureState {
  if (input.networkError) return "offline";
  if (input.status === 429 || input.code === "rate_limited") return "rate_limited";
  if (input.status === 400 || input.code === "invalid_payload") return "field_validation";
  if (input.status === 401 || input.code === "auth_error") return "invalid_credentials";
  return "server_error";
}

export function loginFailureCopy(state: LoginFailureState, retryAfterSeconds?: number | null): string {
  switch (state) {
    case "field_validation":
      return "Enter both your email address and password.";
    case "invalid_credentials":
      // Deliberately does not say which of the two was wrong: doing so tells an
      // attacker whether an account exists for that address.
      return "That email and password combination did not match an account.";
    case "rate_limited":
      return retryAfterSeconds
        ? `Too many attempts. Try again in ${retryAfterSeconds} seconds.`
        : "Too many attempts. Wait a moment before trying again.";
    case "offline":
      return "Could not reach Adsecute. Check your connection and try again — nothing was submitted.";
    case "server_error":
      return "Login is temporarily unavailable. Nothing was changed; please try again.";
  }
}

/* ------------------------------------------------------------------- reset */

export type ResetDeliveryState = "sent" | "delivery_unavailable";

export function resetDeliveryFromResponse(input: {
  status?: number;
  code?: string | null;
  networkError?: boolean;
}): ResetDeliveryState {
  if (input.networkError) return "delivery_unavailable";
  if (input.code === "delivery_unavailable") return "delivery_unavailable";
  if (typeof input.status === "number" && input.status >= 500) return "delivery_unavailable";
  return "sent";
}

export function resetDeliveryCopy(state: ResetDeliveryState): string {
  return state === "sent"
    ? "If an account exists for that address, a reset link is on its way. The link expires shortly."
    : // Says the mail was not sent, rather than the usual reassuring blanket
      // message — a user who waits for an email that never left is stuck.
      "We could not send the reset email. This is our side, not yours; try again shortly or contact support.";
}

/* --------------------------------------------------------- oauth callback */

export interface OAuthCallbackError {
  provider: string;
  code: string;
  /** Provider text, shown verbatim rather than paraphrased. */
  description: string | null;
}

/**
 * Reads an OAuth return that failed.
 *
 * Returns null for a successful return, so a caller cannot accidentally render
 * an error panel on the happy path.
 */
export function oauthCallbackErrorFrom(
  params: URLSearchParams,
  provider: string,
): OAuthCallbackError | null {
  const code = params.get("error") ?? params.get("error_code");
  if (!code) return null;
  return {
    provider,
    code,
    description: params.get("error_description") ?? params.get("error_reason"),
  };
}

export function oauthCallbackCopy(error: OAuthCallbackError): { title: string; body: string } {
  return {
    title: `${error.provider} did not complete the connection`,
    body:
      error.code === "access_denied"
        ? "The connection was declined, so nothing was linked. You can start again when you are ready."
        : "The provider returned an error before anything was linked. Nothing was changed on your account.",
  };
}

/* ---------------------------------------------------------------- language */

/**
 * The public language selector is not functional.
 *
 * `getLanguageFromCookieValue` is pinned to English app-wide, so the selector
 * stores a preference that nothing reads. Saying so is required: presenting it
 * as working would be a claim the product cannot honour.
 */
export const PUBLIC_LANGUAGE_SELECTOR_LIMITATION =
  "Language selection is not active yet. Your choice is saved, but every screen still renders in English until Turkish copy ships.";

/* ------------------------------------------------------- reviewer and demo */

export const REVIEWER_READ_ONLY_COPY =
  "You are signed in as a reviewer. Everything is read-only and no change you make will reach a provider.";
export const DEMO_BUSINESS_COPY =
  "This is the demo business. Its data is illustrative and is not connected to a live ad account.";

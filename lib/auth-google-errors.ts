/**
 * The complete set of messages the Google sign-in callback may put in
 * `/login?error=…`.
 *
 * The login page used to render that query parameter verbatim into its own
 * styled red alert box. React escapes HTML so it was not XSS, but it did mean
 * anyone could compose a link to the real adsecute.com login page displaying
 * any sentence they liked, inside Adsecute's own error styling, next to a
 * pre-fillable `?email=` field — a ready-made phishing panel on a genuine
 * domain.
 *
 * Rendering only known strings removes that. Anything unrecognised falls back
 * to a generic message, so a real failure still tells the user something.
 */
export const GOOGLE_SIGN_IN_ERRORS = [
  "An error occurred during Google sign-in.",
  "Failed to exchange Google authorization code.",
  "Failed to fetch Google profile.",
  "Google Sign-In is not configured.",
  "Google did not return an access token.",
  "Google sign-in was cancelled.",
  "Invalid OAuth state. Please try again.",
  "Missing authorization code or state.",
  "Missing required profile information from Google.",
  "Your Google email is not verified.",
] as const;

export const GENERIC_SIGN_IN_ERROR = "Sign-in failed. Please try again.";

export function resolveSignInError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return (GOOGLE_SIGN_IN_ERRORS as readonly string[]).includes(raw)
    ? raw
    : GENERIC_SIGN_IN_ERROR;
}

/** Digits only: `123-456-7890`, `1234567890` and whitespace are one id. */
export function normalizeGoogleCustomerId(
  value: string | null | undefined,
): string {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

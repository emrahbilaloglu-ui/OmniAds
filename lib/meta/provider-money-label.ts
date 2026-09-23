/**
 * The money string an operator reads before approving a provider write.
 *
 * ## Why this is its own module
 *
 * It existed twice, byte for byte — once in `bid-proposal-producer.ts` and
 * once in `budget-proposal-producer.ts` — and both copies write the SAME
 * column, `meta_automation_proposals.evidence_label`. A currency audit fixed
 * one copy and left the other, which is how a duplicated formatter fails: not
 * by being wrong everywhere, but by being right in the place someone looked.
 *
 * ## Why the carried exponent is not trusted
 *
 * Both callers hold a `currencyExponent` that came from the ISO-4217 registry,
 * and the amount is a PROVIDER minor-unit integer. Meta publishes its own
 * per-currency offset, and it disagrees with ISO for COP, HUF, IDR and TWD
 * (100x) and for BHD and JOD (10x). A HUF proposal for a 50,000-forint bid
 * would have read `HUF 500.00` — a hundredfold understatement on a label whose
 * entire job is to let a person authorise a real money movement.
 *
 * So the decimal point is placed from the provider's own offset, and the
 * carried exponent is CHECKED against it rather than used. Where they disagree,
 * or where the provider publishes no offset for the code, the label states
 * minor units explicitly. An operator can act on `HUF 50000 minor units`; they
 * cannot act on a number that is silently off by a factor of a hundred.
 *
 * Nothing about the envelope changes. `currencyExponent` stays in the proposal
 * fingerprint exactly as it was — this is a presentation decision, not a
 * contract change.
 */
import { resolveMetaCurrencyOffset } from "@/lib/currency/meta-currency-offsets";

export function exactProviderMoneyLabel(input: {
  currency: string;
  /** The exponent the envelope carries. Corroborated here, never trusted. */
  currencyExponent: number;
  minorUnits: number;
}): string {
  const code = input.currency.toUpperCase();
  const sign = input.minorUnits < 0 ? "-" : "";
  const magnitude = String(Math.abs(input.minorUnits));

  const offset = resolveMetaCurrencyOffset(code);
  if (
    offset.status !== "resolved" ||
    offset.subdivisionDigits !== input.currencyExponent
  ) {
    return `${code} ${sign}${magnitude} minor units`;
  }

  const places = offset.subdivisionDigits;
  const digits = magnitude.padStart(places + 1, "0");
  const whole = places === 0 ? digits : digits.slice(0, digits.length - places);
  const fraction = places === 0 ? "" : `.${digits.slice(digits.length - places)}`;
  return `${code} ${sign}${whole}${fraction}`;
}

/**
 * The buyer financial-warning acknowledgement (Flow L).
 *
 * A buyer-audience share puts spend, ROAS and revenue figures in front of
 * someone outside the workspace, on a link that survives the conversation that
 * created it. Those numbers carry limitations — attribution windows, currency,
 * the window they cover — that the sender knows and the recipient does not.
 *
 * So the sender must acknowledge, in the request, that they have seen the
 * financial limitation. Not a checkbox the client can decide to skip: a
 * required field the server refuses without. Every path that could create a
 * buyer share goes through `requireShareAcknowledgement`, so a caller that
 * forgets it gets a 400 rather than a share that quietly omits the warning.
 *
 * Creator-audience shares stay unchanged: they go to people already inside the
 * workspace, who see the same limitations on every internal surface.
 */

/** Exact wording the sender is acknowledging. Stored so it cannot drift. */
export const BUYER_FINANCIAL_WARNING =
  "These figures are provider-reported and attribution-window dependent. They are not " +
  "accounting revenue, they may be restated by the provider, and the recipient will not " +
  "see the limitations that apply to them elsewhere in this workspace.";

/** The literal value the request must carry. */
export const BUYER_ACKNOWLEDGEMENT_VALUE = "financial_limitation_acknowledged";

export type AcknowledgementResult =
  | { ok: true }
  | { ok: false; error: string; message: string };

/**
 * Refuse a buyer share that does not carry the acknowledgement.
 *
 * The check is on the exact value, not on truthiness: `true`, `"yes"` and `1`
 * all mean somebody wired a control without reading what it attests to.
 */
export function requireShareAcknowledgement(input: {
  audience: string | null | undefined;
  acknowledgement: unknown;
}): AcknowledgementResult {
  if (input.audience !== "buyer") return { ok: true };
  if (input.acknowledgement !== BUYER_ACKNOWLEDGEMENT_VALUE) {
    return {
      ok: false,
      error: "financial_acknowledgement_required",
      message:
        "A buyer share requires an explicit financial-limitation acknowledgement. " +
        `Send acknowledgement: "${BUYER_ACKNOWLEDGEMENT_VALUE}".`,
    };
  }
  return { ok: true };
}

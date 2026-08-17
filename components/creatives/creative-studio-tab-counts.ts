import type { CreativeStudioTabId } from "@/components/creatives/creative-studio-exact-types";

/**
 * The Creative Studio tab row's count chips.
 *
 * The reference (`Adsecute Dashboard v2.dc.html`, script line 3379) builds the
 * row from
 *
 *   [['assets','Assets',8], ['copies','Copies',0], ['landers','Landing Pages',0],
 *    ['inbox','Inbox',5], ['audiences','Audiences',0]]
 *
 * with `count: d[2] || ''`. Two things follow, and the app got both wrong:
 *
 *   1. the count is a property of the TAB, not of the current view. The five
 *      Studio routes each passed only their own tab's number, so the chip
 *      appeared to follow the active pill — "Assets —, Copies, …" on
 *      /platforms/meta/creatives and "Assets, Copies —, …" on
 *      /platforms/meta/copies;
 *   2. `|| ''` means a zero draws NO chip. Copies, Landing Pages and Audiences
 *      are zero in every state of the reference, so they carry no chip at all —
 *      yet the app was drawing an em dash on whichever of them was active.
 *
 * So exactly two tabs carry a chip: Assets (how much is here) and Inbox (how
 * much is waiting). This builds that shape from whatever the calling surface
 * genuinely knows, and `null` — the em dash — is what an unserved count renders
 * as, with the chip's geometry intact. The three chipless tabs are absent from
 * the result on every route, because their count is not a fact this screen
 * states.
 */
export function buildCreativeStudioTabCounts(input: {
  /**
   * Creative assets served for the current window, or `null` when this surface
   * was not served them (it is loading, it failed, or no account is scoped).
   */
  assets?: number | null;
  /**
   * Inbox items awaiting triage, or `null` when this surface was not served
   * them.
   */
  inbox?: number | null;
}): Partial<Record<CreativeStudioTabId, number | null>> {
  return {
    assets: input.assets ?? null,
    inbox: input.inbox ?? null,
  };
}

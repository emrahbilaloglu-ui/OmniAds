/**
 * WP-26 / G10 — the visual facts a frame and its reference artboard must share.
 *
 * The previous gate searched generated HTML for `data-el="..."` as a substring.
 * That passes for a marker sitting anywhere at all — wrong parent, wrong order,
 * zero height, clipped out of view, or on a `<span>` that renders nothing. It
 * proved the strings existed, not that the product looked like the design.
 *
 * This extracts what can actually be compared between two rendered documents:
 *
 * - **Ownership and order.** Which marker is a marker's nearest marker
 *   ancestor, and where it sits among its siblings. This is the design's own
 *   region hierarchy, and it is compared exactly — a control moved out of its
 *   panel is a different composition.
 * - **Visibility.** Whether the element renders at all, and whether an ancestor
 *   clips it away. A control the reader cannot see is not a control.
 * - **Geometry, relative to the artboard.** Absolute pixels cannot match: the
 *   reference is a static mock and the implementation renders real data of
 *   different length. What must match is *placement* — which region is above or
 *   left of which — and that a region occupies a comparable share of the
 *   artboard.
 * - **Typography and colour, computed.** Family, weight, size and line-height
 *   as the browser resolved them, and the colours actually painted.
 *
 * Both documents are measured by the same function so a difference is a real
 * difference and not an artefact of two ways of asking.
 */

export interface VisualFact {
  /** `el:home-kpis`, `ctl:live:chart-table-toggle`, `collection:sources`. */
  key: string;
  /** Nearest enclosing marker, or null when the region is top level. */
  owner: string | null;
  /**
   * Every enclosing marker, nearest first.
   *
   * The nearest one alone cannot express what the design states. Where the
   * reference draws a control inside a region, the design fact is that the
   * control *lives in* that region — not that no component may sit between
   * them. A real table inside that region is not a violation of it; a control
   * drawn outside it is. Containment is checked against this chain.
   */
  ownerPath: string[];
  /** Index among siblings that share this owner, in document order. */
  orderInOwner: number;
  visible: boolean;
  /** True when an ancestor's overflow hides this element. */
  clipped: boolean;
  /**
   * True when this sits inside a fixed or absolutely positioned layer.
   *
   * An overlay is drawn on top of the page rather than in its flow, so its
   * vertical position says nothing about whether it comes before or after the
   * content beneath it. The mock draws overlay contents inline under the
   * surface they cover; the product renders them over it.
   */
  overlaid: boolean;
  /** Box relative to the artboard root, as fractions of its width/height. */
  box: { x: number; y: number; width: number; height: number };
  /** Pixel box, for control-anatomy checks like minimum target size. */
  pixels: { width: number; height: number };
  tag: string;
  /** ARIA role, where one is set. A tablist is a control on a div. */
  role: string | null;
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  lineHeightPx: number;
  color: string;
  backgroundColor: string;
  borderRadiusPx: number;
  borderTopWidthPx: number;
  boxShadow: string;
  paddingPx: { top: number; right: number; bottom: number; left: number };
}

export interface VisualSnapshot {
  /** Artboard or frame identity, e.g. `H03`. */
  id: string;
  width: number;
  theme: string;
  facts: VisualFact[];
  /** Every distinct font size painted on visible text, ascending. */
  typeScale: number[];
  /** Every distinct colour painted, as `rgb(...)`. */
  palette: string[];
  /** True when something on the surface scrolls horizontally at this width. */
  sidewaysScroll: boolean;
}

/**
 * The extraction, as a string evaluated inside the page.
 *
 * Kept as source text rather than a function reference because it runs in the
 * browser context of two different documents — the reference artboard and the
 * implementation frame — neither of which shares this module's scope.
 */
export const EXTRACT_VISUAL_FACTS = `(rootSelector) => {
  const root = document.querySelector(rootSelector);
  if (!root) return null;
  const rootRect = root.getBoundingClientRect();

  // One element can be several things at once: the source picker is both the
  // builder-sources region and the sources collection. Returning only the first
  // attribute lost the other, and the gate then reported a region as missing
  // that was on screen the whole time.
  const markerKeys = (node) => {
    const keys = [];
    if (node.hasAttribute("data-el")) keys.push("el:" + node.getAttribute("data-el"));
    if (node.hasAttribute("data-ctl")) keys.push("ctl:" + node.getAttribute("data-ctl"));
    if (node.hasAttribute("data-collection")) keys.push("collection:" + node.getAttribute("data-collection"));
    return keys;
  };

  const markerKey = (node) => markerKeys(node)[0] ?? null;

  const isMarker = (node) => node.nodeType === 1 && markerKey(node) !== null;

  // Clipping: an ancestor that cuts this element off with no way to reach it.
  //
  // Judged per axis, because the two are not the same failure. An ancestor
  // with hidden overflow removes the element from the reader entirely. An
  // ancestor that *scrolls* does not: the content below the fold of a scrolling
  // panel is reached by scrolling, which is what a page is. So the first
  // scrollable ancestor in an axis settles that axis — anything further up is
  // measuring a scroll offset, not a clip.
  const isClipped = (node, rect) => {
    let parent = node.parentElement;
    let xResolved = false;
    let yResolved = false;
    while (parent && parent !== document.body && !(xResolved && yResolved)) {
      const cs = getComputedStyle(parent);
      const pr = parent.getBoundingClientRect();
      const hiddenX = cs.overflowX === "hidden" || cs.overflowX === "clip";
      const hiddenY = cs.overflowY === "hidden" || cs.overflowY === "clip";
      const scrollsX = cs.overflowX === "auto" || cs.overflowX === "scroll";
      const scrollsY = cs.overflowY === "auto" || cs.overflowY === "scroll";
      const outsideX = rect.right <= pr.left + 0.5 || rect.left >= pr.right - 0.5;
      const outsideY = rect.bottom <= pr.top + 0.5 || rect.top >= pr.bottom - 0.5;

      if (!xResolved) {
        if (hiddenX && outsideX) return true;
        if (scrollsX) xResolved = true;
      }
      if (!yResolved) {
        if (hiddenY && outsideY) return true;
        if (scrollsY) yResolved = true;
      }
      parent = parent.parentElement;
    }
    return false;
  };

  const isOverlaid = (node) => {
    let parent = node;
    while (parent && parent !== document.body) {
      const position = getComputedStyle(parent).position;
      if (position === "fixed" || position === "absolute") return true;
      parent = parent.parentElement;
    }
    return false;
  };

  const nodes = [...root.querySelectorAll("[data-el],[data-ctl],[data-collection]")];
  const ownerCount = new Map();
  const facts = [];

  for (const node of nodes) {
    let ancestor = node.parentElement;
    let owner = null;
    const ownerPath = [];
    while (ancestor && ancestor !== root.parentElement) {
      if (isMarker(ancestor)) {
        for (const key of markerKeys(ancestor)) ownerPath.push(key);
        if (owner === null) owner = markerKey(ancestor);
      }
      ancestor = ancestor.parentElement;
    }

    const bucket = owner ?? "";
    const order = ownerCount.get(bucket) ?? 0;
    ownerCount.set(bucket, order + 1);

    const rect = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    const visible =
      cs.display !== "none" &&
      cs.visibility !== "hidden" &&
      Number(cs.opacity) > 0.01 &&
      rect.width > 0 &&
      rect.height > 0;

    const num = (value) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    for (const key of markerKeys(node)) facts.push({
      key,
      owner,
      ownerPath,
      orderInOwner: order,
      visible,
      clipped: visible ? isClipped(node, rect) : false,
      overlaid: isOverlaid(node),
      box: {
        x: rootRect.width ? (rect.left - rootRect.left) / rootRect.width : 0,
        y: rootRect.height ? (rect.top - rootRect.top) / rootRect.height : 0,
        width: rootRect.width ? rect.width / rootRect.width : 0,
        height: rootRect.height ? rect.height / rootRect.height : 0,
      },
      pixels: { width: rect.width, height: rect.height },
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute("role"),
      fontFamily: cs.fontFamily,
      fontSizePx: num(cs.fontSize),
      fontWeight: num(cs.fontWeight) || 400,
      lineHeightPx: cs.lineHeight === "normal" ? num(cs.fontSize) * 1.2 : num(cs.lineHeight),
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      borderRadiusPx: num(cs.borderTopLeftRadius),
      borderTopWidthPx: num(cs.borderTopWidth),
      boxShadow: cs.boxShadow,
      paddingPx: {
        top: num(cs.paddingTop),
        right: num(cs.paddingRight),
        bottom: num(cs.paddingBottom),
        left: num(cs.paddingLeft),
      },
    });
  }

  // Type scale and palette over *painted text* only. An element with no text
  // contributes no type size, and a transparent background contributes no
  // colour — counting either would report sizes and colours nobody can see.
  const sizes = new Set();
  const colors = new Set();
  for (const node of root.querySelectorAll("*")) {
    const cs = getComputedStyle(node);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const ownText = [...node.childNodes].some(
      (child) => child.nodeType === 3 && child.textContent.trim().length > 0,
    );
    if (ownText) {
      sizes.add(Math.round(Number.parseFloat(cs.fontSize) * 10) / 10);
      colors.add(cs.color);
    }
    if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") {
      colors.add(cs.backgroundColor);
    }
  }

  // Does the surface scroll sideways at this width?
  //
  // Vertical scrolling is what a page does; horizontal scrolling is a layout
  // that did not fit and said nothing about it. At 320 and 390 it is how a
  // table pushes its own row actions off the side of the screen, and no single
  // marker's geometry reveals it — the control is reachable, by a gesture
  // nobody knows is available.
  //
  // A container that declares itself a horizontal scroller is exempt. Some
  // content genuinely cannot fit 320px — a six-column plan table is the
  // example — and scrolling that table inside its own frame is the answer.
  // Scrolling the whole surface is not: it moves the navigation, the heading
  // and every other column along with it. The distinction is declared in the
  // markup rather than guessed at here.
  let sidewaysScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  if (!sidewaysScroll) {
    for (const node of root.querySelectorAll("*")) {
      if (node.hasAttribute("data-scroll-x")) continue;
      const cs = getComputedStyle(node);
      if (cs.overflowX !== "auto" && cs.overflowX !== "scroll") continue;
      if (node.scrollWidth > node.clientWidth + 1) { sidewaysScroll = true; break; }
    }
  }

  return {
    facts,
    typeScale: [...sizes].sort((a, b) => a - b),
    palette: [...colors].sort(),
    sidewaysScroll,
  };
}`;

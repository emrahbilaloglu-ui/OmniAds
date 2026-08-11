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
  /** Index among siblings that share this owner, in document order. */
  orderInOwner: number;
  visible: boolean;
  /** True when an ancestor's overflow hides this element. */
  clipped: boolean;
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

  const markerKey = (node) => {
    if (node.hasAttribute("data-el")) return "el:" + node.getAttribute("data-el");
    if (node.hasAttribute("data-ctl")) return "ctl:" + node.getAttribute("data-ctl");
    if (node.hasAttribute("data-collection")) return "collection:" + node.getAttribute("data-collection");
    return null;
  };

  const isMarker = (node) => node.nodeType === 1 && markerKey(node) !== null;

  // Clipping: an ancestor with hidden/scroll overflow whose box does not
  // contain this element. A scrolled-away control is invisible in the capture
  // even though getComputedStyle reports it as displayed.
  const isClipped = (node, rect) => {
    let parent = node.parentElement;
    while (parent && parent !== document.body) {
      const cs = getComputedStyle(parent);
      if (cs.overflow !== "visible" || cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const pr = parent.getBoundingClientRect();
        const outside =
          rect.bottom <= pr.top + 0.5 ||
          rect.top >= pr.bottom - 0.5 ||
          rect.right <= pr.left + 0.5 ||
          rect.left >= pr.right - 0.5;
        if (outside) return true;
      }
      parent = parent.parentElement;
    }
    return false;
  };

  const nodes = [...root.querySelectorAll("[data-el],[data-ctl],[data-collection]")];
  const ownerCount = new Map();
  const facts = [];

  for (const node of nodes) {
    const key = markerKey(node);
    let ancestor = node.parentElement;
    let owner = null;
    while (ancestor && ancestor !== root.parentElement) {
      if (isMarker(ancestor)) { owner = markerKey(ancestor); break; }
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

    facts.push({
      key,
      owner,
      orderInOwner: order,
      visible,
      clipped: visible ? isClipped(node, rect) : false,
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

  return {
    facts,
    typeScale: [...sizes].sort((a, b) => a - b),
    palette: [...colors].sort(),
  };
}`;

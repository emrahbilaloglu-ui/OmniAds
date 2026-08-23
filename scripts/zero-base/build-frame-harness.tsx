/**
 * WP-26 / G10 — render every reference frame to a static page.
 *
 * One file per frame, named by reference id, leaf, state, width and theme, so a
 * capture can never be filed under the wrong id and two frames can never share
 * an image without it being obvious from the filename.
 *
 * The frame is rendered inside the **real shell**. An earlier version of this
 * file wrote `<div data-adc-ui>` and `<main>` into the template string by hand
 * and mounted only the leaf fragment, which meant the rail, top bar, context
 * bar, skip link and drawer — most of what the accepted artboards draw — never
 * appeared in a single capture.
 *
 * Rendering happens in a real DOM rather than through `renderToStaticMarkup`.
 * Two of the shell's states exist only after effects run and content is
 * portalled: the navigation drawer (H60/H61/B05) and the scope sheet
 * (H63/H64) are Radix dialogs, and a portal has nothing to attach to during
 * string rendering. Static markup therefore silently omitted exactly the
 * artboards whose entire subject is an open overlay. A jsdom document runs the
 * effects, mounts the portal host, and yields markup that contains the state
 * the frame is named for.
 *
 * `matchMedia` is implemented against the frame's own width, so the shell's
 * viewport branch is decided by a real query rather than by the SSR hint.
 */
// Must run before any component import: the frame harness renders the real
// exact bodies, which import CSS modules that Node's CommonJS loader hands to
// the JavaScript parser. Without this the frames, reference and fidelity gates
// all fail at step one — which is where they had been failing.
import "./css-module-stub.cts";

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { JSDOM } from "jsdom";

import { FRAMES, frameFileName, frameShellOptions } from "@/scripts/zero-base/frame-registry";
import { withFrameShell } from "@/scripts/zero-base/frame-shell";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "playwright", ".frames");
const THEME_ATTRIBUTE = "data-adc-theme";

function canonicalCss(): string {
  return readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
}

/**
 * The Ledger faces, embedded.
 *
 * `next/font/local` defines `--font-adc-sans` and `--font-adc-mono` at build
 * time, which a static file rendered outside Next never sees. Every captured
 * frame was therefore drawn in Arial and Times — not what ships, and not what
 * the reference is drawn in, which made every font comparison meaningless.
 *
 * The vendored woff2 files are inlined as data URIs so a capture needs no
 * network and no server, and the variables are declared on :root exactly as the
 * font loader declares them. The faces keep their real family names, so a
 * comparison against the reference compares typefaces rather than two packagings
 * of the same one.
 */
function ledgerFontFace(): string {
  const dir = path.join(ROOT, "public", "fonts", "zero-base");
  const sans = readFileSync(path.join(dir, "schibsted-grotesk-variable.woff2")).toString("base64");
  const mono = readFileSync(path.join(dir, "fragment-mono-400.woff2")).toString("base64");
  return `
@font-face{font-family:'Schibsted Grotesk';font-style:normal;font-weight:400 700;font-display:block;src:url(data:font/woff2;base64,${sans}) format('woff2');}
@font-face{font-family:'Fragment Mono';font-style:normal;font-weight:400;font-display:block;src:url(data:font/woff2;base64,${mono}) format('woff2');}
:root{--font-adc-sans:'Schibsted Grotesk';--font-adc-mono:'Fragment Mono';}
`;
}

/** A media-query implementation that answers from the frame's real width. */
function installMatchMedia(window: JSDOM["window"], width: number): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      const min = /min-width:\s*(\d+)px/.exec(query);
      const matches =
        (max ? width <= Number(max[1]) : true) && (min ? width >= Number(min[1]) : true);
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
    },
  });
}

async function renderFrameHtml(
  element: React.ReactElement,
  width: number,
  theme: string,
): Promise<string> {
  const dom = new JSDOM(
    `<!doctype html><html ${THEME_ATTRIBUTE}="${theme}"><body><div id="root"></div></body></html>`,
    { pretendToBeVisual: true },
  );
  const { window } = dom;
  installMatchMedia(window, width);

  // Some of these (notably `navigator`) are getter-only on the Node global, so
  // they must be installed with defineProperty rather than assigned.
  const globals = globalThis as Record<string, unknown>;
  const installed: string[] = [];
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globals, key));
    Object.defineProperty(globals, key, { value, configurable: true, writable: true });
    installed.push(key);
  };

  install("window", window);
  install("self", window);
  install("document", window.document);
  install("navigator", window.navigator);
  install("getComputedStyle", window.getComputedStyle.bind(window));

  // Install the DOM globals wholesale rather than one at a time. Chasing them
  // individually is endless — Radix walks the tree with NodeFilter, next/link
  // dispatches Events, focus management constructs KeyboardEvents — and each
  // missing one surfaces as an unrelated-looking React commit error. jsdom's
  // realm is also strict: an Event built from Node's global constructor is
  // rejected by jsdom's dispatchEvent, so the window's own must win.
  for (const key of Object.getOwnPropertyNames(window)) {
    if (!/^[A-Z]/.test(key)) continue;
    const value = (window as unknown as Record<string, unknown>)[key];
    if (typeof value !== "function" && typeof value !== "object") continue;
    if (value === undefined || value === null) continue;
    install(key, value);
  }

  install("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(Date.now()), 0) as unknown as number);
  install("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
  // next/link observes viewport intersection to prefetch, through an idle
  // callback. Neither exists in jsdom, and without them mounting a single Link
  // throws — which would be every rail item on every frame.
  install("requestIdleCallback", (callback: (deadline: unknown) => void) =>
    window.setTimeout(
      () => callback({ didTimeout: false, timeRemaining: () => 0 }),
      0,
    ) as unknown as number);
  install("cancelIdleCallback", (handle: number) => window.clearTimeout(handle));
  // Radix measures with these; jsdom implements neither.
  const NoopObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  install("ResizeObserver", window.ResizeObserver ?? NoopObserver);
  install("IntersectionObserver", window.IntersectionObserver ?? NoopObserver);
  install("IS_REACT_ACT_ENVIRONMENT", true);

  try {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const container = window.document.getElementById("root")!;
    const root = createRoot(container);
    await act(async () => {
      root.render(element);
    });
    // A second pass lets the portal host publish its node and any overlay that
    // depends on it mount into the canonical container.
    await act(async () => {});
    const html = container.innerHTML;
    await act(async () => {
      root.unmount();
    });
    return html;
  } finally {
    for (const key of installed.reverse()) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globals, key, descriptor);
      else delete globals[key];
    }
    window.close();
  }
}

async function main() {
  // Rebuild from empty.
  //
  // The filename encodes id, leaf, state, width and theme, so renaming a frame
  // — fixing a wrong leaf, say — leaves the old file behind under the same id
  // prefix. The anatomy comparison looks a frame up by that prefix and took
  // whichever file it found first, which meant a corrected frame could still be
  // graded against the composition it used to render. Stale evidence is worse
  // than missing evidence: it reads as a real result.
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const css = canonicalCss();
  const fonts = ledgerFontFace();
  let count = 0;

  for (const spec of FRAMES) {
    const body = await renderFrameHtml(
      withFrameShell(frameShellOptions(spec), spec.render()),
      spec.width,
      spec.theme,
    );
    // The frame markers wrap the composition; they identify the capture without
    // standing in for any part of it.
    const html = `<!doctype html>
<html lang="en" ${THEME_ATTRIBUTE}="${spec.theme}">
<head><meta charset="utf-8"><title>${spec.id} ${spec.leaf} ${spec.state}</title>
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${fonts}</style>
<style>${css}</style>
</head>
<body><div data-frame="${spec.id}" data-frame-leaf="${spec.leaf}" data-frame-state="${spec.state}" style="height:100vh;overflow:hidden">${body}</div></body>
</html>`;
    writeFileSync(path.join(OUT_DIR, `${frameFileName(spec)}.html`), html);
    count += 1;
  }
  console.log(`rendered ${count} frame pages → ${path.relative(ROOT, OUT_DIR)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

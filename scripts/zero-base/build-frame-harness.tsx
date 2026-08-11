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
 * appeared in a single capture. Which shell, and the route the rail marks as
 * current, are derived from the frame's own LeafId rather than restated here,
 * so the crosswalk and the route authority cannot disagree.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

import { FRAMES, frameFileName, frameShellOptions } from "@/scripts/zero-base/frame-registry";
import { withFrameShell } from "@/scripts/zero-base/frame-shell";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "playwright", ".frames");
const THEME_ATTRIBUTE = "data-adc-theme";

function canonicalCss(): string {
  return readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const css = canonicalCss();
  let count = 0;

  for (const spec of FRAMES) {
    const body = renderToStaticMarkup(
      withFrameShell(frameShellOptions(spec), spec.render()),
    );
    // The frame markers wrap the composition; they identify the capture without
    // standing in for any part of it.
    const html = `<!doctype html>
<html lang="en" ${THEME_ATTRIBUTE}="${spec.theme}">
<head><meta charset="utf-8"><title>${spec.id} ${spec.leaf} ${spec.state}</title>
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${css}</style>
</head>
<body><div data-frame="${spec.id}" data-frame-leaf="${spec.leaf}" data-frame-state="${spec.state}" style="height:100vh;overflow:hidden">${body}</div></body>
</html>`;
    writeFileSync(path.join(OUT_DIR, `${frameFileName(spec)}.html`), html);
    count += 1;
  }
  console.log(`rendered ${count} frame pages → ${path.relative(ROOT, OUT_DIR)}`);
}

main();

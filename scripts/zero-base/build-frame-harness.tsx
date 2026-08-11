/**
 * WP-26 / G10 — render every reference frame to a static page.
 *
 * One file per frame, named by reference id, leaf, state, width and theme, so a
 * capture can never be filed under the wrong id and two frames can never share
 * an image without it being obvious from the filename.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

import { FRAMES, frameFileName } from "@/scripts/zero-base/frame-registry";
import { MAIN_CONTENT_TABINDEX } from "@/components/zero-base/shell/skip-link";

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
    const narrow = spec.width < 1024;
    const body = renderToStaticMarkup(spec.render());
    const html = `<!doctype html>
<html lang="en" ${THEME_ATTRIBUTE}="${spec.theme}">
<head><meta charset="utf-8"><title>${spec.id} ${spec.leaf} ${spec.state}</title>
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${css}</style>
</head>
<body><div data-adc-ui="zero-base" data-frame="${spec.id}" data-frame-leaf="${spec.leaf}" data-frame-state="${spec.state}" style="height:100vh;display:flex;flex-direction:column;overflow:hidden">
<main id="zero-base-main" tabindex="${MAIN_CONTENT_TABINDEX}" style="flex:1 1 auto;min-width:0;min-height:0;padding:${narrow ? 16 : 40}px;overflow-x:auto;overflow-y:auto">${body}</main>
</div></body>
</html>`;
    writeFileSync(path.join(OUT_DIR, `${frameFileName(spec)}.html`), html);
    count += 1;
  }
  console.log(`rendered ${count} frame pages → ${path.relative(ROOT, OUT_DIR)}`);
}

main();

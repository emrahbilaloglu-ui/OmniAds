import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { EXTRACT_VISUAL_FACTS, type VisualSnapshot } from "@/lib/zero-base/visual-facts";
import { FRAMES, frameFileName } from "@/scripts/zero-base/frame-registry";

const FRAME_PAGES = path.resolve("playwright/.frames");

async function main() {
  const ref = JSON.parse(readFileSync(path.resolve("docs/zero-base-design/v3/reference-visual.json"), "utf8"));
  const browser = await chromium.launch();
  for (const id of process.argv.slice(2)) {
    const r: VisualSnapshot = ref.snapshots.find((s: VisualSnapshot) => s.id === id);
    const spec = FRAMES.find((f) => f.id === id)!;
    const page = await browser.newPage({ viewport: { width: spec.width, height: 1600 } });
    await page.goto(`file://${path.join(FRAME_PAGES, `${frameFileName(spec)}.html`)}`, { waitUntil: "domcontentloaded" });
    const measured = (await page.evaluate(`(${EXTRACT_VISUAL_FACTS})("body")`)) as VisualSnapshot;
    await page.close();
    const dump = (facts: VisualSnapshot["facts"], label: string) => {
      console.log(" " + label);
      const seen = new Set<string>();
      for (const f of [...facts].sort((a, b) => a.box.y - b.box.y)) {
        if (seen.has(f.key)) continue;
        seen.add(f.key);
        console.log(`   y=${f.box.y.toFixed(3)} owner=${f.owner ?? "-"} ${f.key}`);
      }
    };
    console.log("== " + id);
    dump(r.facts, "reference");
    dump(measured.facts, "implementation");
  }
  await browser.close();
}
main();

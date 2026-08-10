# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: full-ui-redesign-smoke.spec.ts >> full UI redesign route and visual smoke >> covers every in-scope route and captures representative visuals
- Location: playwright/tests/full-ui-redesign-smoke.spec.ts:1040:7

# Error details

```
Error: /login has essential text below 12px or 4.5:1

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "1.00:1 \"Skip to main content\"",
+ ]
```

# Test source

```ts
  1260 |                   const r = el.getBoundingClientRect();
  1261 |                   return r.height < 24 || r.width < 24;
  1262 |                 })
  1263 |                 .map((el) => {
  1264 |                   const r = el.getBoundingClientRect();
  1265 |                   return `${el.getAttribute("aria-label") || el.tagName}: ${Math.round(r.width)}x${Math.round(r.height)}`;
  1266 |                 })
  1267 |                 .slice(0, 6),
  1268 |             };
  1269 |           });
  1270 | 
  1271 | 
  1272 |         // No card may print a percentage for a comparison that was never made.
  1273 |         //
  1274 |         // Under Compare=None `changePct` is null, and the summary cards
  1275 |         // rendered `0.0%` for it while the Pins strip on the same screen said
  1276 |         // "No comparison selected". Zero percent is a measurement; "not
  1277 |         // compared" is not, and the two were indistinguishable.
  1278 |         {
  1279 |           const fabricated = await shotPage.evaluate(() =>
  1280 |             Array.from(
  1281 |               document.querySelectorAll<HTMLElement>('[data-delta-state="unavailable"]'),
  1282 |             )
  1283 |               .map((el) => (el.textContent ?? "").trim())
  1284 |               .filter((text) => /\d/.test(text))
  1285 |               .slice(0, 5),
  1286 |           );
  1287 |           expect(
  1288 |             fabricated,
  1289 |             `${shot.path} prints a percentage for a comparison that does not exist`,
  1290 |           ).toEqual([]);
  1291 |         }
  1292 | 
  1293 |         // Essential text has to be readable: at least 12px and at least 4.5:1.
  1294 |         {
  1295 |           const unreadable = await shotPage.evaluate(() => {
  1296 |             const luminance = (rgb: string) => {
  1297 |               const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).map(
  1298 |                 (v) => Number(v) / 255,
  1299 |               );
  1300 |               const ch = (c: number) =>
  1301 |                 c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  1302 |               return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  1303 |             };
  1304 |             const backdrop = (el: HTMLElement): string => {
  1305 |               let node: HTMLElement | null = el;
  1306 |               while (node) {
  1307 |                 const bg = getComputedStyle(node).backgroundColor;
  1308 |                 if (bg && !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/.test(bg)) return bg;
  1309 |                 node = node.parentElement;
  1310 |               }
  1311 |               return "rgb(255,255,255)";
  1312 |             };
  1313 |             const offenders: string[] = [];
  1314 |             const main = document.querySelector("#main-content") ?? document.body;
  1315 |             for (const el of Array.from(main.querySelectorAll<HTMLElement>("*"))) {
  1316 |               const text = Array.from(el.childNodes)
  1317 |                 .filter((n) => n.nodeType === Node.TEXT_NODE)
  1318 |                 .map((n) => (n.textContent ?? "").trim())
  1319 |                 .join("");
  1320 |               if (text.length < 3) continue;
  1321 |               const style = getComputedStyle(el);
  1322 |               if (style.visibility === "hidden" || style.display === "none") continue;
  1323 |               // Decorative and disabled content is exempt by declaration, not
  1324 |               // by being quietly hard to read.
  1325 |               if (el.getAttribute("aria-hidden") === "true") continue;
  1326 |               if (el.closest("[data-decorative='true']")) continue;
  1327 | 
  1328 |               // Visually-hidden text has no rendered contrast to measure. The
  1329 |               // skip link is the case that matters: it is deliberately clipped
  1330 |               // until focused, and must stay in the accessibility tree, so it
  1331 |               // cannot be excluded with aria-hidden. Measuring it reported
  1332 |               // 1.00:1 for something no sighted user ever sees, which would
  1333 |               // have made the real 11.5px findings look like noise.
  1334 |               const rect = el.getBoundingClientRect();
  1335 |               const clipped =
  1336 |                 style.clip === "rect(0px, 0px, 0px, 0px)" ||
  1337 |                 style.clipPath === "inset(50%)" ||
  1338 |                 rect.width <= 1 ||
  1339 |                 rect.height <= 1;
  1340 |               if (clipped) continue;
  1341 | 
  1342 |               const size = Number.parseFloat(style.fontSize);
  1343 |               if (size > 0 && size < 12) {
  1344 |                 offenders.push(`${size}px: "${text.slice(0, 22)}"`);
  1345 |                 continue;
  1346 |               }
  1347 |               const fg = luminance(style.color);
  1348 |               const bg = luminance(backdrop(el));
  1349 |               const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
  1350 |               const ratio = (hi + 0.05) / (lo + 0.05);
  1351 |               if (ratio < 4.5) {
  1352 |                 offenders.push(`${ratio.toFixed(2)}:1 "${text.slice(0, 22)}"`);
  1353 |               }
  1354 |             }
  1355 |             return offenders.slice(0, 8);
  1356 |           });
  1357 |           expect(
  1358 |             unreadable,
  1359 |             `${shot.path} has essential text below 12px or 4.5:1`,
> 1360 |           ).toEqual([]);
       |             ^ Error: /login has essential text below 12px or 4.5:1
  1361 |         }
  1362 | 
  1363 |           if (topbar) {
  1364 |             expect(
  1365 |               topbar.overlaps,
  1366 |               `${shot.path} topbar controls physically overlap at ${shotPage.viewportSize()?.width}px`,
  1367 |             ).toEqual([]);
  1368 |             expect(
  1369 |               topbar.freshnessVisible,
  1370 |               `${shot.path} lost the freshness reading while fixing the topbar`,
  1371 |             ).toBe(true);
  1372 |             expect(
  1373 |               topbar.smallTargets,
  1374 |               `${shot.path} topbar has touch targets below 24px`,
  1375 |             ).toEqual([]);
  1376 |           }
  1377 |         }
  1378 | 
  1379 |         // Live accessibility checks. These need a real browser: focus
  1380 |         // visibility, Escape behaviour and zoom cannot be read off markup.
  1381 |         {
  1382 |           // 1. Every focusable control has a visible focus indicator. A focus
  1383 |           //    ring removed for aesthetics makes keyboard navigation invisible.
  1384 |           const focusInvisible = await shotPage.evaluate(() => {
  1385 |             const offenders: string[] = [];
  1386 |             const focusables = Array.from(
  1387 |               document.querySelectorAll<HTMLElement>(
  1388 |                 "a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex='-1'])",
  1389 |               ),
  1390 |             ).slice(0, 40);
  1391 |             for (const element of focusables) {
  1392 |               element.focus();
  1393 |               if (document.activeElement !== element) continue;
  1394 |               const style = window.getComputedStyle(element);
  1395 |               const hasRing =
  1396 |                 style.outlineStyle !== "none" ||
  1397 |                 style.boxShadow !== "none" ||
  1398 |                 style.borderColor !== "";
  1399 |               if (!hasRing) offenders.push(element.tagName.toLowerCase());
  1400 |             }
  1401 |             return offenders.slice(0, 5);
  1402 |           });
  1403 |           expect(
  1404 |             focusInvisible,
  1405 |             `${shot.path} has focusable controls with no visible focus`,
  1406 |           ).toEqual([]);
  1407 | 
  1408 |           // 2. No positive tabindex. It reorders the whole page's tab sequence
  1409 |           //    and is nearly always a bug rather than an intent.
  1410 |           const positiveTabindex = await shotPage.evaluate(
  1411 |             () =>
  1412 |               Array.from(document.querySelectorAll("[tabindex]")).filter(
  1413 |                 (element) =>
  1414 |                   Number.parseInt(element.getAttribute("tabindex") ?? "0", 10) > 0,
  1415 |               ).length,
  1416 |           );
  1417 |           expect(
  1418 |             positiveTabindex,
  1419 |             `${shot.path} uses a positive tabindex`,
  1420 |           ).toBe(0);
  1421 | 
  1422 |           // 3. Every image is either described or explicitly decorative. An
  1423 |           //    undescribed image is announced as its file name.
  1424 |           const undescribedImages = await shotPage.evaluate(
  1425 |             () =>
  1426 |               Array.from(document.querySelectorAll("img")).filter(
  1427 |                 (image) =>
  1428 |                   image.getAttribute("alt") === null &&
  1429 |                   image.getAttribute("aria-hidden") !== "true" &&
  1430 |                   image.getAttribute("role") !== "presentation",
  1431 |               ).length,
  1432 |           );
  1433 |           expect(
  1434 |             undescribedImages,
  1435 |             `${shot.path} has images with neither alt nor aria-hidden`,
  1436 |           ).toBe(0);
  1437 | 
  1438 |           // 4. Reduced motion is honoured: no element may animate when the
  1439 |           //    viewer has asked for stillness.
  1440 |           await shotPage.emulateMedia({ reducedMotion: "reduce" });
  1441 |           const animating = await shotPage.evaluate(() => {
  1442 |             return Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
  1443 |               (element) => {
  1444 |                 const style = window.getComputedStyle(element);
  1445 |                 const duration = Number.parseFloat(style.animationDuration);
  1446 |                 return (
  1447 |                   style.animationName !== "none" &&
  1448 |                   Number.isFinite(duration) &&
  1449 |                   duration > 0.05
  1450 |                 );
  1451 |               },
  1452 |             ).length;
  1453 |           });
  1454 |           await shotPage.emulateMedia({ reducedMotion: null });
  1455 |           expect(
  1456 |             animating,
  1457 |             `${shot.path} keeps animating under prefers-reduced-motion`,
  1458 |           ).toBe(0);
  1459 |         }
  1460 | 
```
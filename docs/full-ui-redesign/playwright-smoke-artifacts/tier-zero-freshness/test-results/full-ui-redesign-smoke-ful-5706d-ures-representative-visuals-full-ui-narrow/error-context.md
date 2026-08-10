# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: full-ui-redesign-smoke.spec.ts >> full UI redesign route and visual smoke >> covers every in-scope route and captures representative visuals
- Location: playwright/tests/full-ui-redesign-smoke.spec.ts:1040:7

# Error details

```
Error: /platforms/meta/history has essential text below 12px or 4.5:1

expect(received).toEqual(expected) // deep equality

- Expected  -  1
+ Received  + 10

- Array []
+ Array [
+   "4.31:1 \"History\"",
+   "4.31:1 \"Search\"",
+   "4.31:1 \"Kind\"",
+   "4.31:1 \"Entity\"",
+   "4.31:1 \"Label\"",
+   "4.11:1 \"Source\"",
+   "4.11:1 \"Persisted ID\"",
+   "4.11:1 \"Account scope\"",
+ ]
```

# Test source

```ts
  1270 |                   return `${el.getAttribute("aria-label") || el.tagName}: ${Math.round(r.width)}x${Math.round(r.height)}`;
  1271 |                 })
  1272 |                 .slice(0, 6),
  1273 |             };
  1274 |           });
  1275 | 
  1276 | 
  1277 |         // No card may print a percentage for a comparison that was never made.
  1278 |         //
  1279 |         // Under Compare=None `changePct` is null, and the summary cards
  1280 |         // rendered `0.0%` for it while the Pins strip on the same screen said
  1281 |         // "No comparison selected". Zero percent is a measurement; "not
  1282 |         // compared" is not, and the two were indistinguishable.
  1283 |         {
  1284 |           const fabricated = await shotPage.evaluate(() =>
  1285 |             Array.from(
  1286 |               document.querySelectorAll<HTMLElement>('[data-delta-state="unavailable"]'),
  1287 |             )
  1288 |               .map((el) => (el.textContent ?? "").trim())
  1289 |               .filter((text) => /\d/.test(text))
  1290 |               .slice(0, 5),
  1291 |           );
  1292 |           expect(
  1293 |             fabricated,
  1294 |             `${shot.path} prints a percentage for a comparison that does not exist`,
  1295 |           ).toEqual([]);
  1296 |         }
  1297 | 
  1298 |         // Essential text has to be readable: at least 12px and at least 4.5:1.
  1299 |         {
  1300 |           const unreadable = await shotPage.evaluate(() => {
  1301 |             const luminance = (rgb: string) => {
  1302 |               const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).map(
  1303 |                 (v) => Number(v) / 255,
  1304 |               );
  1305 |               const ch = (c: number) =>
  1306 |                 c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  1307 |               return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  1308 |             };
  1309 |             const backdrop = (el: HTMLElement): string => {
  1310 |               let node: HTMLElement | null = el;
  1311 |               while (node) {
  1312 |                 const bg = getComputedStyle(node).backgroundColor;
  1313 |                 if (bg && !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/.test(bg)) return bg;
  1314 |                 node = node.parentElement;
  1315 |               }
  1316 |               return "rgb(255,255,255)";
  1317 |             };
  1318 |             const offenders: string[] = [];
  1319 |             const main = document.querySelector("#main-content") ?? document.body;
  1320 |             for (const el of Array.from(main.querySelectorAll<HTMLElement>("*"))) {
  1321 |               const text = Array.from(el.childNodes)
  1322 |                 .filter((n) => n.nodeType === Node.TEXT_NODE)
  1323 |                 .map((n) => (n.textContent ?? "").trim())
  1324 |                 .join("");
  1325 |               if (text.length < 3) continue;
  1326 |               const style = getComputedStyle(el);
  1327 |               if (style.visibility === "hidden" || style.display === "none") continue;
  1328 |               // Decorative and disabled content is exempt by declaration, not
  1329 |               // by being quietly hard to read.
  1330 |               if (el.getAttribute("aria-hidden") === "true") continue;
  1331 |               if (el.closest("[data-decorative='true']")) continue;
  1332 | 
  1333 |               // Visually-hidden text has no rendered contrast to measure. The
  1334 |               // skip link is the case that matters: it sits at left:-9999px
  1335 |               // until focused, and must stay in the accessibility tree, so it
  1336 |               // cannot be excluded with aria-hidden. Measuring it reported
  1337 |               // 1.00:1 for something no sighted user ever sees, which would
  1338 |               // have made the real 11.5px findings look like noise. Both the
  1339 |               // off-screen and the clip technique count as hidden.
  1340 |               const rect = el.getBoundingClientRect();
  1341 |               const offScreen =
  1342 |                 rect.right <= 0 ||
  1343 |                 rect.bottom <= 0 ||
  1344 |                 rect.left >= window.innerWidth;
  1345 |               const clipped =
  1346 |                 style.clip === "rect(0px, 0px, 0px, 0px)" ||
  1347 |                 style.clipPath === "inset(50%)" ||
  1348 |                 rect.width <= 1 ||
  1349 |                 rect.height <= 1;
  1350 |               if (offScreen || clipped) continue;
  1351 | 
  1352 |               const size = Number.parseFloat(style.fontSize);
  1353 |               if (size > 0 && size < 12) {
  1354 |                 offenders.push(`${size}px: "${text.slice(0, 22)}"`);
  1355 |                 continue;
  1356 |               }
  1357 |               const fg = luminance(style.color);
  1358 |               const bg = luminance(backdrop(el));
  1359 |               const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
  1360 |               const ratio = (hi + 0.05) / (lo + 0.05);
  1361 |               if (ratio < 4.5) {
  1362 |                 offenders.push(`${ratio.toFixed(2)}:1 "${text.slice(0, 22)}"`);
  1363 |               }
  1364 |             }
  1365 |             return offenders.slice(0, 8);
  1366 |           });
  1367 |           expect(
  1368 |             unreadable,
  1369 |             `${shot.path} has essential text below 12px or 4.5:1`,
> 1370 |           ).toEqual([]);
       |             ^ Error: /platforms/meta/history has essential text below 12px or 4.5:1
  1371 |         }
  1372 | 
  1373 |           if (topbar) {
  1374 |             expect(
  1375 |               topbar.overlaps,
  1376 |               `${shot.path} topbar controls physically overlap at ${shotPage.viewportSize()?.width}px`,
  1377 |             ).toEqual([]);
  1378 |             expect(
  1379 |               topbar.freshnessVisible,
  1380 |               `${shot.path} lost the freshness reading while fixing the topbar`,
  1381 |             ).toBe(true);
  1382 |             expect(
  1383 |               topbar.smallTargets,
  1384 |               `${shot.path} topbar has touch targets below 24px`,
  1385 |             ).toEqual([]);
  1386 |           }
  1387 |         }
  1388 | 
  1389 |         // Live accessibility checks. These need a real browser: focus
  1390 |         // visibility, Escape behaviour and zoom cannot be read off markup.
  1391 |         {
  1392 |           // 1. Every focusable control has a visible focus indicator. A focus
  1393 |           //    ring removed for aesthetics makes keyboard navigation invisible.
  1394 |           const focusInvisible = await shotPage.evaluate(() => {
  1395 |             const offenders: string[] = [];
  1396 |             const focusables = Array.from(
  1397 |               document.querySelectorAll<HTMLElement>(
  1398 |                 "a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex='-1'])",
  1399 |               ),
  1400 |             ).slice(0, 40);
  1401 |             for (const element of focusables) {
  1402 |               element.focus();
  1403 |               if (document.activeElement !== element) continue;
  1404 |               const style = window.getComputedStyle(element);
  1405 |               const hasRing =
  1406 |                 style.outlineStyle !== "none" ||
  1407 |                 style.boxShadow !== "none" ||
  1408 |                 style.borderColor !== "";
  1409 |               if (!hasRing) offenders.push(element.tagName.toLowerCase());
  1410 |             }
  1411 |             return offenders.slice(0, 5);
  1412 |           });
  1413 |           expect(
  1414 |             focusInvisible,
  1415 |             `${shot.path} has focusable controls with no visible focus`,
  1416 |           ).toEqual([]);
  1417 | 
  1418 |           // 2. No positive tabindex. It reorders the whole page's tab sequence
  1419 |           //    and is nearly always a bug rather than an intent.
  1420 |           const positiveTabindex = await shotPage.evaluate(
  1421 |             () =>
  1422 |               Array.from(document.querySelectorAll("[tabindex]")).filter(
  1423 |                 (element) =>
  1424 |                   Number.parseInt(element.getAttribute("tabindex") ?? "0", 10) > 0,
  1425 |               ).length,
  1426 |           );
  1427 |           expect(
  1428 |             positiveTabindex,
  1429 |             `${shot.path} uses a positive tabindex`,
  1430 |           ).toBe(0);
  1431 | 
  1432 |           // 3. Every image is either described or explicitly decorative. An
  1433 |           //    undescribed image is announced as its file name.
  1434 |           const undescribedImages = await shotPage.evaluate(
  1435 |             () =>
  1436 |               Array.from(document.querySelectorAll("img")).filter(
  1437 |                 (image) =>
  1438 |                   image.getAttribute("alt") === null &&
  1439 |                   image.getAttribute("aria-hidden") !== "true" &&
  1440 |                   image.getAttribute("role") !== "presentation",
  1441 |               ).length,
  1442 |           );
  1443 |           expect(
  1444 |             undescribedImages,
  1445 |             `${shot.path} has images with neither alt nor aria-hidden`,
  1446 |           ).toBe(0);
  1447 | 
  1448 |           // 4. Reduced motion is honoured: no element may animate when the
  1449 |           //    viewer has asked for stillness.
  1450 |           await shotPage.emulateMedia({ reducedMotion: "reduce" });
  1451 |           const animating = await shotPage.evaluate(() => {
  1452 |             return Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
  1453 |               (element) => {
  1454 |                 const style = window.getComputedStyle(element);
  1455 |                 const duration = Number.parseFloat(style.animationDuration);
  1456 |                 return (
  1457 |                   style.animationName !== "none" &&
  1458 |                   Number.isFinite(duration) &&
  1459 |                   duration > 0.05
  1460 |                 );
  1461 |               },
  1462 |             ).length;
  1463 |           });
  1464 |           await shotPage.emulateMedia({ reducedMotion: null });
  1465 |           expect(
  1466 |             animating,
  1467 |             `${shot.path} keeps animating under prefers-reduced-motion`,
  1468 |           ).toBe(0);
  1469 |         }
  1470 | 
```
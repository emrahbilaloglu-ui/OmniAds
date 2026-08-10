# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: full-ui-redesign-smoke.spec.ts >> full UI redesign route and visual smoke >> covers every in-scope route and captures representative visuals
- Location: playwright/tests/full-ui-redesign-smoke.spec.ts:1040:7

# Error details

```
Error: /platforms/meta topbar has touch targets below 24px

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "DIV: 300x23",
+ ]
```

# Test source

```ts
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
  1329 |               // skip link is the case that matters: it sits at left:-9999px
  1330 |               // until focused, and must stay in the accessibility tree, so it
  1331 |               // cannot be excluded with aria-hidden. Measuring it reported
  1332 |               // 1.00:1 for something no sighted user ever sees, which would
  1333 |               // have made the real 11.5px findings look like noise. Both the
  1334 |               // off-screen and the clip technique count as hidden.
  1335 |               const rect = el.getBoundingClientRect();
  1336 |               const offScreen =
  1337 |                 rect.right <= 0 ||
  1338 |                 rect.bottom <= 0 ||
  1339 |                 rect.left >= window.innerWidth;
  1340 |               const clipped =
  1341 |                 style.clip === "rect(0px, 0px, 0px, 0px)" ||
  1342 |                 style.clipPath === "inset(50%)" ||
  1343 |                 rect.width <= 1 ||
  1344 |                 rect.height <= 1;
  1345 |               if (offScreen || clipped) continue;
  1346 | 
  1347 |               const size = Number.parseFloat(style.fontSize);
  1348 |               if (size > 0 && size < 12) {
  1349 |                 offenders.push(`${size}px: "${text.slice(0, 22)}"`);
  1350 |                 continue;
  1351 |               }
  1352 |               const fg = luminance(style.color);
  1353 |               const bg = luminance(backdrop(el));
  1354 |               const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
  1355 |               const ratio = (hi + 0.05) / (lo + 0.05);
  1356 |               if (ratio < 4.5) {
  1357 |                 offenders.push(`${ratio.toFixed(2)}:1 "${text.slice(0, 22)}"`);
  1358 |               }
  1359 |             }
  1360 |             return offenders.slice(0, 8);
  1361 |           });
  1362 |           expect(
  1363 |             unreadable,
  1364 |             `${shot.path} has essential text below 12px or 4.5:1`,
  1365 |           ).toEqual([]);
  1366 |         }
  1367 | 
  1368 |           if (topbar) {
  1369 |             expect(
  1370 |               topbar.overlaps,
  1371 |               `${shot.path} topbar controls physically overlap at ${shotPage.viewportSize()?.width}px`,
  1372 |             ).toEqual([]);
  1373 |             expect(
  1374 |               topbar.freshnessVisible,
  1375 |               `${shot.path} lost the freshness reading while fixing the topbar`,
  1376 |             ).toBe(true);
  1377 |             expect(
  1378 |               topbar.smallTargets,
  1379 |               `${shot.path} topbar has touch targets below 24px`,
> 1380 |             ).toEqual([]);
       |               ^ Error: /platforms/meta topbar has touch targets below 24px
  1381 |           }
  1382 |         }
  1383 | 
  1384 |         // Live accessibility checks. These need a real browser: focus
  1385 |         // visibility, Escape behaviour and zoom cannot be read off markup.
  1386 |         {
  1387 |           // 1. Every focusable control has a visible focus indicator. A focus
  1388 |           //    ring removed for aesthetics makes keyboard navigation invisible.
  1389 |           const focusInvisible = await shotPage.evaluate(() => {
  1390 |             const offenders: string[] = [];
  1391 |             const focusables = Array.from(
  1392 |               document.querySelectorAll<HTMLElement>(
  1393 |                 "a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex='-1'])",
  1394 |               ),
  1395 |             ).slice(0, 40);
  1396 |             for (const element of focusables) {
  1397 |               element.focus();
  1398 |               if (document.activeElement !== element) continue;
  1399 |               const style = window.getComputedStyle(element);
  1400 |               const hasRing =
  1401 |                 style.outlineStyle !== "none" ||
  1402 |                 style.boxShadow !== "none" ||
  1403 |                 style.borderColor !== "";
  1404 |               if (!hasRing) offenders.push(element.tagName.toLowerCase());
  1405 |             }
  1406 |             return offenders.slice(0, 5);
  1407 |           });
  1408 |           expect(
  1409 |             focusInvisible,
  1410 |             `${shot.path} has focusable controls with no visible focus`,
  1411 |           ).toEqual([]);
  1412 | 
  1413 |           // 2. No positive tabindex. It reorders the whole page's tab sequence
  1414 |           //    and is nearly always a bug rather than an intent.
  1415 |           const positiveTabindex = await shotPage.evaluate(
  1416 |             () =>
  1417 |               Array.from(document.querySelectorAll("[tabindex]")).filter(
  1418 |                 (element) =>
  1419 |                   Number.parseInt(element.getAttribute("tabindex") ?? "0", 10) > 0,
  1420 |               ).length,
  1421 |           );
  1422 |           expect(
  1423 |             positiveTabindex,
  1424 |             `${shot.path} uses a positive tabindex`,
  1425 |           ).toBe(0);
  1426 | 
  1427 |           // 3. Every image is either described or explicitly decorative. An
  1428 |           //    undescribed image is announced as its file name.
  1429 |           const undescribedImages = await shotPage.evaluate(
  1430 |             () =>
  1431 |               Array.from(document.querySelectorAll("img")).filter(
  1432 |                 (image) =>
  1433 |                   image.getAttribute("alt") === null &&
  1434 |                   image.getAttribute("aria-hidden") !== "true" &&
  1435 |                   image.getAttribute("role") !== "presentation",
  1436 |               ).length,
  1437 |           );
  1438 |           expect(
  1439 |             undescribedImages,
  1440 |             `${shot.path} has images with neither alt nor aria-hidden`,
  1441 |           ).toBe(0);
  1442 | 
  1443 |           // 4. Reduced motion is honoured: no element may animate when the
  1444 |           //    viewer has asked for stillness.
  1445 |           await shotPage.emulateMedia({ reducedMotion: "reduce" });
  1446 |           const animating = await shotPage.evaluate(() => {
  1447 |             return Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
  1448 |               (element) => {
  1449 |                 const style = window.getComputedStyle(element);
  1450 |                 const duration = Number.parseFloat(style.animationDuration);
  1451 |                 return (
  1452 |                   style.animationName !== "none" &&
  1453 |                   Number.isFinite(duration) &&
  1454 |                   duration > 0.05
  1455 |                 );
  1456 |               },
  1457 |             ).length;
  1458 |           });
  1459 |           await shotPage.emulateMedia({ reducedMotion: null });
  1460 |           expect(
  1461 |             animating,
  1462 |             `${shot.path} keeps animating under prefers-reduced-motion`,
  1463 |           ).toBe(0);
  1464 |         }
  1465 | 
  1466 |         // The typography floor, checked on what the browser actually computed
  1467 |         // rather than on the stylesheet: a cascade or an inline style can
  1468 |         // still land under it.
  1469 |         const tinyText = await shotPage.evaluate(() => {
  1470 |           const offenders: string[] = [];
  1471 |           for (const element of Array.from(document.body.querySelectorAll("*"))) {
  1472 |             const text = (element.textContent ?? "").trim();
  1473 |             if (!text || element.children.length > 0) continue;
  1474 |             const size = Number.parseFloat(
  1475 |               window.getComputedStyle(element).fontSize,
  1476 |             );
  1477 |             if (Number.isFinite(size) && size < 11) {
  1478 |               const cls =
  1479 |                 typeof element.className === "string"
  1480 |                   ? element.className.slice(0, 60)
```
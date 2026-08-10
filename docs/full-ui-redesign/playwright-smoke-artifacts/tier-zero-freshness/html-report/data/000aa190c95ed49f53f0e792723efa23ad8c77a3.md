# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: full-ui-redesign-smoke.spec.ts >> full UI redesign route and visual smoke >> covers every in-scope route and captures representative visuals
- Location: playwright/tests/full-ui-redesign-smoke.spec.ts:1040:7

# Error details

```
Error: /platforms/meta/copies has essential text below 12px or 4.5:1

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "1.60:1 \"data as of 8/10/2026, \"",
+ ]
```

# Test source

```ts
  1339 |               } catch {
  1340 |                 return null;
  1341 |               }
  1342 |               return null;
  1343 |             };
  1344 | 
  1345 |             const luminance = (rgb: [number, number, number]) => {
  1346 |               const [r, g, b] = rgb.map((v) => v / 255);
  1347 |               const ch = (c: number) =>
  1348 |                 c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  1349 |               return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  1350 |             };
  1351 |             // Composite up the tree so a translucent tint is measured against
  1352 |             // what is actually behind it, not as if it were opaque.
  1353 |             const backdrop = (el: HTMLElement): [number, number, number] => {
  1354 |               const layers: Array<[number, number, number, number]> = [];
  1355 |               let node: HTMLElement | null = el.parentElement;
  1356 |               while (node) {
  1357 |                 const parsed = toRgb(getComputedStyle(node).backgroundColor);
  1358 |                 if (parsed && parsed[3] > 0) {
  1359 |                   layers.push(parsed);
  1360 |                   if (parsed[3] >= 1) break;
  1361 |                 }
  1362 |                 node = node.parentElement;
  1363 |               }
  1364 |               let [r, g, b] = [255, 255, 255];
  1365 |               for (let i = layers.length - 1; i >= 0; i -= 1) {
  1366 |                 const [lr, lg, lb, la] = layers[i];
  1367 |                 r = lr * la + r * (1 - la);
  1368 |                 g = lg * la + g * (1 - la);
  1369 |                 b = lb * la + b * (1 - la);
  1370 |               }
  1371 |               return [r, g, b];
  1372 |             };
  1373 |             const offenders: string[] = [];
  1374 |             const main = document.querySelector("#main-content") ?? document.body;
  1375 |             for (const el of Array.from(main.querySelectorAll<HTMLElement>("*"))) {
  1376 |               const text = Array.from(el.childNodes)
  1377 |                 .filter((n) => n.nodeType === Node.TEXT_NODE)
  1378 |                 .map((n) => (n.textContent ?? "").trim())
  1379 |                 .join("");
  1380 |               if (text.length < 3) continue;
  1381 |               const style = getComputedStyle(el);
  1382 |               if (style.visibility === "hidden" || style.display === "none") continue;
  1383 |               // Decorative and disabled content is exempt by declaration, not
  1384 |               // by being quietly hard to read.
  1385 |               if (el.getAttribute("aria-hidden") === "true") continue;
  1386 |               if (el.closest("[data-decorative='true']")) continue;
  1387 | 
  1388 |               // Visually-hidden text has no rendered contrast to measure. The
  1389 |               // skip link is the case that matters: it sits at left:-9999px
  1390 |               // until focused, and must stay in the accessibility tree, so it
  1391 |               // cannot be excluded with aria-hidden. Measuring it reported
  1392 |               // 1.00:1 for something no sighted user ever sees, which would
  1393 |               // have made the real 11.5px findings look like noise. Both the
  1394 |               // off-screen and the clip technique count as hidden.
  1395 |               const rect = el.getBoundingClientRect();
  1396 |               const offScreen =
  1397 |                 rect.right <= 0 ||
  1398 |                 rect.bottom <= 0 ||
  1399 |                 rect.left >= window.innerWidth;
  1400 |               const clipped =
  1401 |                 style.clip === "rect(0px, 0px, 0px, 0px)" ||
  1402 |                 style.clipPath === "inset(50%)" ||
  1403 |                 rect.width <= 1 ||
  1404 |                 rect.height <= 1;
  1405 |               if (offScreen || clipped) continue;
  1406 | 
  1407 |               const size = Number.parseFloat(style.fontSize);
  1408 |               if (size > 0 && size < 12) {
  1409 |                 offenders.push(`${size}px: "${text.slice(0, 22)}"`);
  1410 |                 continue;
  1411 |               }
  1412 |               const colour = toRgb(style.color);
  1413 |               // Own background first, composited over what is behind it.
  1414 |               const own = toRgb(style.backgroundColor);
  1415 |               const behind = backdrop(el);
  1416 |               let surface = behind;
  1417 |               if (own && own[3] > 0) {
  1418 |                 surface = [
  1419 |                   own[0] * own[3] + behind[0] * (1 - own[3]),
  1420 |                   own[1] * own[3] + behind[1] * (1 - own[3]),
  1421 |                   own[2] * own[3] + behind[2] * (1 - own[3]),
  1422 |                 ];
  1423 |               }
  1424 |               // A colour the engine will not resolve is skipped, not guessed.
  1425 |               if (!colour) continue;
  1426 |               const fg = luminance([colour[0], colour[1], colour[2]]);
  1427 |               const bg = luminance(surface);
  1428 |               const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
  1429 |               const ratio = (hi + 0.05) / (lo + 0.05);
  1430 |               if (ratio < 4.5) {
  1431 |                 offenders.push(`${ratio.toFixed(2)}:1 "${text.slice(0, 22)}"`);
  1432 |               }
  1433 |             }
  1434 |             return offenders.slice(0, 8);
  1435 |           });
  1436 |           expect(
  1437 |             unreadable,
  1438 |             `${shot.path} has essential text below 12px or 4.5:1`,
> 1439 |           ).toEqual([]);
       |             ^ Error: /platforms/meta/copies has essential text below 12px or 4.5:1
  1440 |         }
  1441 | 
  1442 |           if (topbar) {
  1443 |             expect(
  1444 |               topbar.overlaps,
  1445 |               `${shot.path} topbar controls physically overlap at ${shotPage.viewportSize()?.width}px`,
  1446 |             ).toEqual([]);
  1447 |             expect(
  1448 |               topbar.freshnessVisible,
  1449 |               `${shot.path} lost the freshness reading while fixing the topbar`,
  1450 |             ).toBe(true);
  1451 |             expect(
  1452 |               topbar.smallTargets,
  1453 |               `${shot.path} topbar has touch targets below 24px`,
  1454 |             ).toEqual([]);
  1455 |           }
  1456 |         }
  1457 | 
  1458 |         // Live accessibility checks. These need a real browser: focus
  1459 |         // visibility, Escape behaviour and zoom cannot be read off markup.
  1460 |         {
  1461 |           // 1. Every focusable control has a visible focus indicator. A focus
  1462 |           //    ring removed for aesthetics makes keyboard navigation invisible.
  1463 |           const focusInvisible = await shotPage.evaluate(() => {
  1464 |             const offenders: string[] = [];
  1465 |             const focusables = Array.from(
  1466 |               document.querySelectorAll<HTMLElement>(
  1467 |                 "a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex='-1'])",
  1468 |               ),
  1469 |             ).slice(0, 40);
  1470 |             for (const element of focusables) {
  1471 |               element.focus();
  1472 |               if (document.activeElement !== element) continue;
  1473 |               const style = window.getComputedStyle(element);
  1474 |               const hasRing =
  1475 |                 style.outlineStyle !== "none" ||
  1476 |                 style.boxShadow !== "none" ||
  1477 |                 style.borderColor !== "";
  1478 |               if (!hasRing) offenders.push(element.tagName.toLowerCase());
  1479 |             }
  1480 |             return offenders.slice(0, 5);
  1481 |           });
  1482 |           expect(
  1483 |             focusInvisible,
  1484 |             `${shot.path} has focusable controls with no visible focus`,
  1485 |           ).toEqual([]);
  1486 | 
  1487 |           // 2. No positive tabindex. It reorders the whole page's tab sequence
  1488 |           //    and is nearly always a bug rather than an intent.
  1489 |           const positiveTabindex = await shotPage.evaluate(
  1490 |             () =>
  1491 |               Array.from(document.querySelectorAll("[tabindex]")).filter(
  1492 |                 (element) =>
  1493 |                   Number.parseInt(element.getAttribute("tabindex") ?? "0", 10) > 0,
  1494 |               ).length,
  1495 |           );
  1496 |           expect(
  1497 |             positiveTabindex,
  1498 |             `${shot.path} uses a positive tabindex`,
  1499 |           ).toBe(0);
  1500 | 
  1501 |           // 3. Every image is either described or explicitly decorative. An
  1502 |           //    undescribed image is announced as its file name.
  1503 |           const undescribedImages = await shotPage.evaluate(
  1504 |             () =>
  1505 |               Array.from(document.querySelectorAll("img")).filter(
  1506 |                 (image) =>
  1507 |                   image.getAttribute("alt") === null &&
  1508 |                   image.getAttribute("aria-hidden") !== "true" &&
  1509 |                   image.getAttribute("role") !== "presentation",
  1510 |               ).length,
  1511 |           );
  1512 |           expect(
  1513 |             undescribedImages,
  1514 |             `${shot.path} has images with neither alt nor aria-hidden`,
  1515 |           ).toBe(0);
  1516 | 
  1517 |           // 4. Reduced motion is honoured: no element may animate when the
  1518 |           //    viewer has asked for stillness.
  1519 |           await shotPage.emulateMedia({ reducedMotion: "reduce" });
  1520 |           const animating = await shotPage.evaluate(() => {
  1521 |             return Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
  1522 |               (element) => {
  1523 |                 const style = window.getComputedStyle(element);
  1524 |                 const duration = Number.parseFloat(style.animationDuration);
  1525 |                 return (
  1526 |                   style.animationName !== "none" &&
  1527 |                   Number.isFinite(duration) &&
  1528 |                   duration > 0.05
  1529 |                 );
  1530 |               },
  1531 |             ).length;
  1532 |           });
  1533 |           await shotPage.emulateMedia({ reducedMotion: null });
  1534 |           expect(
  1535 |             animating,
  1536 |             `${shot.path} keeps animating under prefers-reduced-motion`,
  1537 |           ).toBe(0);
  1538 |         }
  1539 | 
```
# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: full-ui-redesign-smoke.spec.ts >> full UI redesign route and visual smoke >> covers every in-scope route and captures representative visuals
- Location: playwright/tests/full-ui-redesign-smoke.spec.ts:978:7

# Error details

```
Error: /overview clips tabular content inside a scroller

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "overflow-x-auto rounded-xl border border-neutral-200 bg-white hides 205px",
+ ]
```

# Test source

```ts
  982  |     test.setTimeout(900_000);
  983  | 
  984  |     const darkProject = testInfo.project.name.endsWith("-dark");
  985  |     if (darkProject) {
  986  |       await page.context().addInitScript(() => {
  987  |         const enableDark = () => document.documentElement?.classList.add("dark");
  988  |         enableDark();
  989  |         document.addEventListener("DOMContentLoaded", enableDark, { once: true });
  990  |       });
  991  |     }
  992  | 
  993  |     const reviewerSeed = await seedReviewerAccount();
  994  |     const reviewer = {
  995  |       email: reviewerSeed.reviewer.email,
  996  |       password: reviewerSeed.reviewer.password,
  997  |     };
  998  |     await seedMetaDecisionDemoData();
  999  |     const admin = await seedAdminAccount();
  1000 | 
  1001 |     if (testInfo.project.name === "full-ui-desktop" && !VISUAL_ONLY) {
  1002 |       const publicRequest = await playwright.request.newContext({
  1003 |         baseURL: SMOKE_BASE_URL,
  1004 |       });
  1005 |       const dashboardRequest = await playwright.request.newContext({
  1006 |         baseURL: SMOKE_BASE_URL,
  1007 |       });
  1008 |       const adminRequest = await playwright.request.newContext({
  1009 |         baseURL: SMOKE_BASE_URL,
  1010 |       });
  1011 |       try {
  1012 |         await smokeRouteResponses(publicRequest, PUBLIC_ROUTES);
  1013 |         await signInRequest(dashboardRequest, reviewer);
  1014 |         await smokeRouteResponses(dashboardRequest, DASHBOARD_ROUTES);
  1015 |         await signInRequest(adminRequest, admin);
  1016 |         await smokeRouteResponses(adminRequest, ADMIN_ROUTES);
  1017 |       } finally {
  1018 |         await publicRequest.dispose();
  1019 |         await dashboardRequest.dispose();
  1020 |         await adminRequest.dispose();
  1021 |       }
  1022 |     }
  1023 | 
  1024 |     for (const shot of ACTIVE_SCREENSHOT_ROUTES) {
  1025 |       if (shot.actor === "admin") {
  1026 |         await signIn(page, admin);
  1027 |       } else if (shot.actor === "dashboard") {
  1028 |         await signIn(page, reviewer);
  1029 |       }
  1030 | 
  1031 |       const shotPage = await page.context().newPage();
  1032 |       try {
  1033 |         await assertRouteHealthy(shotPage, shot.path);
  1034 |         await waitForDashboardWorkspaceReady(shotPage, shot.path);
  1035 |         await assertRepresentativeVisualSettled(shotPage, shot.path);
  1036 | 
  1037 |         // No surface may scroll the page sideways on a phone. A single
  1038 |         // overflowing child does it, and it is exactly how the assessment
  1039 |         // column ended up off-screen in the 390px Studio artifact. A passing
  1040 |         // screenshot is not acceptance if content is pushed out of frame, so
  1041 |         // this is asserted rather than eyeballed.
  1042 |         if ((shotPage.viewportSize()?.width ?? 1440) <= 480) {
  1043 |           const overflow = await shotPage.evaluate(() => ({
  1044 |             scrollWidth: document.documentElement.scrollWidth,
  1045 |             innerWidth: window.innerWidth,
  1046 |           }));
  1047 |           expect(
  1048 |             overflow.scrollWidth,
  1049 |             `${shot.path} scrolls horizontally at ${overflow.innerWidth}px (scrollWidth ${overflow.scrollWidth})`,
  1050 |           ).toBeLessThanOrEqual(overflow.innerWidth);
  1051 |         }
  1052 | 
  1053 |         // Page-level overflow is not enough: a frame with overflow:auto keeps
  1054 |         // the page from scrolling while its own content is still cut off, which
  1055 |         // is exactly how the assessment column stayed off-screen at 390px while
  1056 |         // every page-level check passed. Assert no scroller hides content.
  1057 |         if ((shotPage.viewportSize()?.width ?? 1440) <= 480) {
  1058 |           const clipped = await shotPage.evaluate(() => {
  1059 |             const offenders: string[] = [];
  1060 |             for (const element of Array.from(
  1061 |               document.body.querySelectorAll<HTMLElement>("*"),
  1062 |             )) {
  1063 |               const style = window.getComputedStyle(element);
  1064 |               const scrolls =
  1065 |                 style.overflowX === "auto" || style.overflowX === "scroll";
  1066 |               if (!scrolls) continue;
  1067 |               const hidden = element.scrollWidth - element.clientWidth;
  1068 |               // Tab strips and toolbars are deliberately swipeable; a data
  1069 |               // frame hiding a column is not the same thing, so only flag
  1070 |               // scrollers that actually contain tabular content.
  1071 |               if (hidden > 4 && element.querySelector("table")) {
  1072 |                 offenders.push(
  1073 |                   `${element.className || element.tagName} hides ${hidden}px`,
  1074 |                 );
  1075 |               }
  1076 |             }
  1077 |             return offenders.slice(0, 5);
  1078 |           });
  1079 |           expect(
  1080 |             clipped,
  1081 |             `${shot.path} clips tabular content inside a scroller`,
> 1082 |           ).toEqual([]);
       |             ^ Error: /overview clips tabular content inside a scroller
  1083 |         }
  1084 | 
  1085 |         // Live accessibility checks. These need a real browser: focus
  1086 |         // visibility, Escape behaviour and zoom cannot be read off markup.
  1087 |         {
  1088 |           // 1. Every focusable control has a visible focus indicator. A focus
  1089 |           //    ring removed for aesthetics makes keyboard navigation invisible.
  1090 |           const focusInvisible = await shotPage.evaluate(() => {
  1091 |             const offenders: string[] = [];
  1092 |             const focusables = Array.from(
  1093 |               document.querySelectorAll<HTMLElement>(
  1094 |                 "a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex='-1'])",
  1095 |               ),
  1096 |             ).slice(0, 40);
  1097 |             for (const element of focusables) {
  1098 |               element.focus();
  1099 |               if (document.activeElement !== element) continue;
  1100 |               const style = window.getComputedStyle(element);
  1101 |               const hasRing =
  1102 |                 style.outlineStyle !== "none" ||
  1103 |                 style.boxShadow !== "none" ||
  1104 |                 style.borderColor !== "";
  1105 |               if (!hasRing) offenders.push(element.tagName.toLowerCase());
  1106 |             }
  1107 |             return offenders.slice(0, 5);
  1108 |           });
  1109 |           expect(
  1110 |             focusInvisible,
  1111 |             `${shot.path} has focusable controls with no visible focus`,
  1112 |           ).toEqual([]);
  1113 | 
  1114 |           // 2. No positive tabindex. It reorders the whole page's tab sequence
  1115 |           //    and is nearly always a bug rather than an intent.
  1116 |           const positiveTabindex = await shotPage.evaluate(
  1117 |             () =>
  1118 |               Array.from(document.querySelectorAll("[tabindex]")).filter(
  1119 |                 (element) =>
  1120 |                   Number.parseInt(element.getAttribute("tabindex") ?? "0", 10) > 0,
  1121 |               ).length,
  1122 |           );
  1123 |           expect(
  1124 |             positiveTabindex,
  1125 |             `${shot.path} uses a positive tabindex`,
  1126 |           ).toBe(0);
  1127 | 
  1128 |           // 3. Every image is either described or explicitly decorative. An
  1129 |           //    undescribed image is announced as its file name.
  1130 |           const undescribedImages = await shotPage.evaluate(
  1131 |             () =>
  1132 |               Array.from(document.querySelectorAll("img")).filter(
  1133 |                 (image) =>
  1134 |                   image.getAttribute("alt") === null &&
  1135 |                   image.getAttribute("aria-hidden") !== "true" &&
  1136 |                   image.getAttribute("role") !== "presentation",
  1137 |               ).length,
  1138 |           );
  1139 |           expect(
  1140 |             undescribedImages,
  1141 |             `${shot.path} has images with neither alt nor aria-hidden`,
  1142 |           ).toBe(0);
  1143 | 
  1144 |           // 4. Reduced motion is honoured: no element may animate when the
  1145 |           //    viewer has asked for stillness.
  1146 |           await shotPage.emulateMedia({ reducedMotion: "reduce" });
  1147 |           const animating = await shotPage.evaluate(() => {
  1148 |             return Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
  1149 |               (element) => {
  1150 |                 const style = window.getComputedStyle(element);
  1151 |                 const duration = Number.parseFloat(style.animationDuration);
  1152 |                 return (
  1153 |                   style.animationName !== "none" &&
  1154 |                   Number.isFinite(duration) &&
  1155 |                   duration > 0.05
  1156 |                 );
  1157 |               },
  1158 |             ).length;
  1159 |           });
  1160 |           await shotPage.emulateMedia({ reducedMotion: null });
  1161 |           expect(
  1162 |             animating,
  1163 |             `${shot.path} keeps animating under prefers-reduced-motion`,
  1164 |           ).toBe(0);
  1165 |         }
  1166 | 
  1167 |         // The typography floor, checked on what the browser actually computed
  1168 |         // rather than on the stylesheet: a cascade or an inline style can
  1169 |         // still land under it.
  1170 |         const tinyText = await shotPage.evaluate(() => {
  1171 |           const offenders: string[] = [];
  1172 |           for (const element of Array.from(document.body.querySelectorAll("*"))) {
  1173 |             const text = (element.textContent ?? "").trim();
  1174 |             if (!text || element.children.length > 0) continue;
  1175 |             const size = Number.parseFloat(
  1176 |               window.getComputedStyle(element).fontSize,
  1177 |             );
  1178 |             if (Number.isFinite(size) && size < 11) {
  1179 |               const cls =
  1180 |                 typeof element.className === "string"
  1181 |                   ? element.className.slice(0, 60)
  1182 |                   : "";
```
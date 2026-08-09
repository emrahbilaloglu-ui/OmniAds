# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: full-ui-redesign-smoke.spec.ts >> full UI redesign route and visual smoke >> covers every in-scope route and captures representative visuals
- Location: playwright/tests/full-ui-redesign-smoke.spec.ts:954:7

# Error details

```
Error: /platforms/meta/copies keeps animating under prefers-reduced-motion

expect(received).toBe(expected) // Object.is equality

Expected: 0
Received: 4
```

# Test source

```ts
  1040 |               const scrolls =
  1041 |                 style.overflowX === "auto" || style.overflowX === "scroll";
  1042 |               if (!scrolls) continue;
  1043 |               const hidden = element.scrollWidth - element.clientWidth;
  1044 |               // Tab strips and toolbars are deliberately swipeable; a data
  1045 |               // frame hiding a column is not the same thing, so only flag
  1046 |               // scrollers that actually contain tabular content.
  1047 |               if (hidden > 4 && element.querySelector("table")) {
  1048 |                 offenders.push(
  1049 |                   `${element.className || element.tagName} hides ${hidden}px`,
  1050 |                 );
  1051 |               }
  1052 |             }
  1053 |             return offenders.slice(0, 5);
  1054 |           });
  1055 |           expect(
  1056 |             clipped,
  1057 |             `${shot.path} clips tabular content inside a scroller`,
  1058 |           ).toEqual([]);
  1059 |         }
  1060 | 
  1061 |         // Live accessibility checks. These need a real browser: focus
  1062 |         // visibility, Escape behaviour and zoom cannot be read off markup.
  1063 |         {
  1064 |           // 1. Every focusable control has a visible focus indicator. A focus
  1065 |           //    ring removed for aesthetics makes keyboard navigation invisible.
  1066 |           const focusInvisible = await shotPage.evaluate(() => {
  1067 |             const offenders: string[] = [];
  1068 |             const focusables = Array.from(
  1069 |               document.querySelectorAll<HTMLElement>(
  1070 |                 "a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex='-1'])",
  1071 |               ),
  1072 |             ).slice(0, 40);
  1073 |             for (const element of focusables) {
  1074 |               element.focus();
  1075 |               if (document.activeElement !== element) continue;
  1076 |               const style = window.getComputedStyle(element);
  1077 |               const hasRing =
  1078 |                 style.outlineStyle !== "none" ||
  1079 |                 style.boxShadow !== "none" ||
  1080 |                 style.borderColor !== "";
  1081 |               if (!hasRing) offenders.push(element.tagName.toLowerCase());
  1082 |             }
  1083 |             return offenders.slice(0, 5);
  1084 |           });
  1085 |           expect(
  1086 |             focusInvisible,
  1087 |             `${shot.path} has focusable controls with no visible focus`,
  1088 |           ).toEqual([]);
  1089 | 
  1090 |           // 2. No positive tabindex. It reorders the whole page's tab sequence
  1091 |           //    and is nearly always a bug rather than an intent.
  1092 |           const positiveTabindex = await shotPage.evaluate(
  1093 |             () =>
  1094 |               Array.from(document.querySelectorAll("[tabindex]")).filter(
  1095 |                 (element) =>
  1096 |                   Number.parseInt(element.getAttribute("tabindex") ?? "0", 10) > 0,
  1097 |               ).length,
  1098 |           );
  1099 |           expect(
  1100 |             positiveTabindex,
  1101 |             `${shot.path} uses a positive tabindex`,
  1102 |           ).toBe(0);
  1103 | 
  1104 |           // 3. Every image is either described or explicitly decorative. An
  1105 |           //    undescribed image is announced as its file name.
  1106 |           const undescribedImages = await shotPage.evaluate(
  1107 |             () =>
  1108 |               Array.from(document.querySelectorAll("img")).filter(
  1109 |                 (image) =>
  1110 |                   image.getAttribute("alt") === null &&
  1111 |                   image.getAttribute("aria-hidden") !== "true" &&
  1112 |                   image.getAttribute("role") !== "presentation",
  1113 |               ).length,
  1114 |           );
  1115 |           expect(
  1116 |             undescribedImages,
  1117 |             `${shot.path} has images with neither alt nor aria-hidden`,
  1118 |           ).toBe(0);
  1119 | 
  1120 |           // 4. Reduced motion is honoured: no element may animate when the
  1121 |           //    viewer has asked for stillness.
  1122 |           await shotPage.emulateMedia({ reducedMotion: "reduce" });
  1123 |           const animating = await shotPage.evaluate(() => {
  1124 |             return Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
  1125 |               (element) => {
  1126 |                 const style = window.getComputedStyle(element);
  1127 |                 const duration = Number.parseFloat(style.animationDuration);
  1128 |                 return (
  1129 |                   style.animationName !== "none" &&
  1130 |                   Number.isFinite(duration) &&
  1131 |                   duration > 0.05
  1132 |                 );
  1133 |               },
  1134 |             ).length;
  1135 |           });
  1136 |           await shotPage.emulateMedia({ reducedMotion: null });
  1137 |           expect(
  1138 |             animating,
  1139 |             `${shot.path} keeps animating under prefers-reduced-motion`,
> 1140 |           ).toBe(0);
       |             ^ Error: /platforms/meta/copies keeps animating under prefers-reduced-motion
  1141 |         }
  1142 | 
  1143 |         // The typography floor, checked on what the browser actually computed
  1144 |         // rather than on the stylesheet: a cascade or an inline style can
  1145 |         // still land under it.
  1146 |         const tinyText = await shotPage.evaluate(() => {
  1147 |           const offenders: string[] = [];
  1148 |           for (const element of Array.from(document.body.querySelectorAll("*"))) {
  1149 |             const text = (element.textContent ?? "").trim();
  1150 |             if (!text || element.children.length > 0) continue;
  1151 |             const size = Number.parseFloat(
  1152 |               window.getComputedStyle(element).fontSize,
  1153 |             );
  1154 |             if (Number.isFinite(size) && size < 11) {
  1155 |               const cls =
  1156 |                 typeof element.className === "string"
  1157 |                   ? element.className.slice(0, 60)
  1158 |                   : "";
  1159 |               offenders.push(
  1160 |                 `${element.tagName.toLowerCase()}.${cls} @ ${size}px :: ${text.slice(0, 24)}`,
  1161 |               );
  1162 |             }
  1163 |           }
  1164 |           return offenders.slice(0, 10);
  1165 |         });
  1166 |         expect(
  1167 |           tinyText,
  1168 |           `${shot.path} renders text below the 11px floor`,
  1169 |         ).toEqual([]);
  1170 |         if (darkProject && shot.actor !== "public") {
  1171 |           await expect
  1172 |             .poll(
  1173 |               () =>
  1174 |                 shotPage.locator(".ad-console-shell").evaluate((element) =>
  1175 |                   getComputedStyle(element).getPropertyValue("--adc-s1").trim(),
  1176 |                 ),
  1177 |               {
  1178 |                 message: `${shot.path} did not activate the dark console token set`,
  1179 |                 timeout: 10_000,
  1180 |               },
  1181 |             )
  1182 |             .toBe("#111315");
  1183 |           await assertDarkConsoleContrast(shotPage, shot.path);
  1184 |         }
  1185 |         await shotPage.screenshot({
  1186 |           path: testInfo.outputPath(
  1187 |             `${testInfo.project.name}-${shot.name}.png`,
  1188 |           ),
  1189 |           fullPage: true,
  1190 |         });
  1191 | 
  1192 |         const advancedCalendarTestId =
  1193 |           shot.name === "meta-decisions"
  1194 |             ? "meta-decisions-date-range-picker-trigger"
  1195 |             : shot.name === "creative-studio"
  1196 |               ? "creative-studio-date-range-picker-trigger"
  1197 |               : null;
  1198 |         if (advancedCalendarTestId) {
  1199 |           const calendarTrigger = shotPage.getByTestId(advancedCalendarTestId);
  1200 |           const calendarRoot = shotPage.getByTestId(
  1201 |             advancedCalendarTestId.replace(/-trigger$/, ""),
  1202 |           );
  1203 |           await expect(calendarTrigger, `${shot.name} advanced calendar trigger`).toBeVisible();
  1204 |           await expect(calendarRoot).toHaveAttribute("data-hydrated", "true");
  1205 |           await calendarTrigger.click();
  1206 |           await expect(
  1207 |             shotPage.getByText("Quick Select", { exact: true }),
  1208 |             `${shot.name} quick ranges`,
  1209 |           ).toBeVisible();
  1210 |           const visibleCalendars = shotPage.locator(
  1211 |             'section[aria-label$=" calendar"]:visible',
  1212 |           );
  1213 |           // The calendar collapses to a single month on narrow viewports. Key
  1214 |           // the expectation off the actual width, not off one project name --
  1215 |           // otherwise every new width added to the matrix inherits the wrong
  1216 |           // expectation and fails for a reason that has nothing to do with it.
  1217 |           const calendarViewport = shotPage.viewportSize();
  1218 |           await expect(visibleCalendars).toHaveCount(
  1219 |             (calendarViewport?.width ?? 1440) < 640 ? 1 : 2,
  1220 |           );
  1221 |           await expect
  1222 |             .poll(() =>
  1223 |               shotPage.evaluate(
  1224 |                 () => document.documentElement.scrollWidth <= window.innerWidth,
  1225 |               ),
  1226 |             )
  1227 |             .toBe(true);
  1228 |           await shotPage.screenshot({
  1229 |             path: testInfo.outputPath(
  1230 |               `${testInfo.project.name}-${shot.name}-calendar.png`,
  1231 |             ),
  1232 |             fullPage: true,
  1233 |           });
  1234 |           await shotPage.keyboard.press("Escape");
  1235 |         }
  1236 | 
  1237 |         const singleDatePickerTestId =
  1238 |           shot.name === "meta-history"
  1239 |             ? "meta-history-from-date-trigger"
  1240 |             : shot.name === "admin-discount-new"
```
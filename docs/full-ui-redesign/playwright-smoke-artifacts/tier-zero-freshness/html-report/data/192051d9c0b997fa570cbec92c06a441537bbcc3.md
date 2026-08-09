# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: full-ui-redesign-smoke.spec.ts >> full UI redesign route and visual smoke >> covers every in-scope route and captures representative visuals
- Location: playwright/tests/full-ui-redesign-smoke.spec.ts:1025:7

# Error details

```
Error: apiRequestContext.post: read ECONNRESET
Call log:
  - → POST http://127.0.0.1:52591/api/auth/login
    - user-agent: Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Mobile Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br
    - content-type: application/json
    - content-length: 78
    - cookie: adsecute_locale=en; omniads_session=524a286b68f3f37b13368042330b9ae03a09be9286b2158f80b91f4ae58336b7

```

# Test source

```ts
  537 |        )
  538 |        ON CONFLICT (scope_type, scope_id, snapshot_date, rec_type)
  539 |        DO UPDATE SET
  540 |          business_id = EXCLUDED.business_id,
  541 |          rec_id = EXCLUDED.rec_id,
  542 |          level = EXCLUDED.level,
  543 |          decision_state = EXCLUDED.decision_state,
  544 |          confidence_score = EXCLUDED.confidence_score,
  545 |          evidence = EXCLUDED.evidence,
  546 |          recommended_action = EXCLUDED.recommended_action,
  547 |          target_value = EXCLUDED.target_value,
  548 |          expected_impact = EXCLUDED.expected_impact,
  549 |          reasoning = EXCLUDED.reasoning,
  550 |          predictive_overlay = EXCLUDED.predictive_overlay,
  551 |          engine_version = EXCLUDED.engine_version,
  552 |          kind = EXCLUDED.kind,
  553 |          evidence_trail = EXCLUDED.evidence_trail,
  554 |          campaign_role = EXCLUDED.campaign_role,
  555 |          bid_regime = EXCLUDED.bid_regime,
  556 |          decision_label = EXCLUDED.decision_label,
  557 |          state_reason = EXCLUDED.state_reason,
  558 |          calibration_scope = EXCLUDED.calibration_scope,
  559 |          signal_quality = EXCLUDED.signal_quality,
  560 |          created_at = now()`,
  561 |       [
  562 |         adsetId,
  563 |         DEMO_BUSINESS_ID,
  564 |         snapshotDate,
  565 |         recommendation.id,
  566 |         JSON.stringify({ items: recommendation.evidence, recommendation }),
  567 |         JSON.stringify(recommendation.targetValue),
  568 |         JSON.stringify(recommendation.evidenceTrail),
  569 |         JSON.stringify(recommendation.calibrationScope),
  570 |         JSON.stringify(recommendation.signalQuality),
  571 |       ],
  572 |     );
  573 |   } finally {
  574 |     await client.end();
  575 |   }
  576 | }
  577 | 
  578 | /**
  579 |  * POST the login endpoint, tolerating the two things that are not failures.
  580 |  *
  581 |  * A 429 is the rate limiter doing its job: the extended matrix authenticates
  582 |  * the same reviewer from six projects in quick succession, which is exactly the
  583 |  * pattern the limiter exists to stop. Backing off keeps a real protection
  584 |  * intact rather than weakening it to make a test convenient.
  585 |  *
  586 |  * A connection reset is the dev server closing a socket while it is still
  587 |  * settling. It throws rather than returning a status, so the 429 loop never
  588 |  * saw it and one reset failed the whole width matrix. A gate that fails for
  589 |  * reasons unrelated to the product is a gate people learn to ignore, which is
  590 |  * worse than not having it.
  591 |  *
  592 |  * Everything else is surfaced unchanged. Only transport-level resets are
  593 |  * retried, and only a bounded number of times, so a genuinely broken login
  594 |  * still fails the run.
  595 |  */
  596 | async function postLoginWithBackoff(
  597 |   post: (path: string, options: { data: SmokeActor }) => Promise<APIResponse>,
  598 |   actor: SmokeActor,
  599 |   wait: (ms: number) => Promise<void>,
  600 | ): Promise<APIResponse> {
  601 |   let lastTransportError: unknown = null;
  602 | 
  603 |   for (let attempt = 0; attempt <= 6; attempt += 1) {
  604 |     if (attempt > 0) await wait(attempt * 1_500);
  605 |     try {
  606 |       const response = await post("/api/auth/login", { data: actor });
  607 |       if (response.status() !== 429) return response;
  608 |       lastTransportError = null;
  609 |     } catch (error) {
  610 |       const message = error instanceof Error ? error.message : String(error);
  611 |       const isTransportReset =
  612 |         /ECONNRESET|ECONNREFUSED|socket hang up|EPIPE|Connection closed/i.test(
  613 |           message,
  614 |         );
  615 |       // Anything that is not a reset is a real failure and must not be retried
  616 |       // into silence.
  617 |       if (!isTransportReset) throw error;
  618 |       lastTransportError = error;
  619 |     }
  620 |   }
  621 | 
  622 |   if (lastTransportError) throw lastTransportError;
  623 |   return post("/api/auth/login", { data: actor });
  624 | }
  625 | 
  626 | async function signIn(page: Page, actor: SmokeActor) {
  627 |   // BrowserContext.request shares its cookie jar with every page in the
  628 |   // context. Authenticating here avoids a pending /login UI redirect racing
  629 |   // the representative route navigation.
  630 |   //
  631 |   // The login endpoint is rate-limited, and it should be. Running the extended
  632 |   // width matrix means several projects authenticating the same reviewer in
  633 |   // quick succession, which is exactly the pattern the limiter exists to stop.
  634 |   // Backing off and retrying keeps the limiter intact rather than weakening a
  635 |   // real protection to make a test convenient.
  636 |   const loginResponse = await postLoginWithBackoff(
> 637 |     (path, options) => page.request.post(path, options),
      |                                     ^ Error: apiRequestContext.post: read ECONNRESET
  638 |     actor,
  639 |     (ms) => page.waitForTimeout(ms),
  640 |   );
  641 |   expect(
  642 |     loginResponse.ok(),
  643 |     `login failed for ${actor.email}: ${loginResponse.status()} ${await loginResponse.text()}`,
  644 |   ).toBe(true);
  645 |   await expect
  646 |     .poll(async () => (await page.request.get("/api/auth/me")).status())
  647 |     .toBe(200);
  648 | }
  649 | 
  650 | async function signInRequest(context: APIRequestContext, actor: SmokeActor) {
  651 |   const response = await postLoginWithBackoff(
  652 |     (path, options) => context.post(path, options),
  653 |     actor,
  654 |     (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  655 |   );
  656 |   expect(
  657 |     response.ok(),
  658 |     `request login failed for ${actor.email}: ${response.status()}`,
  659 |   ).toBe(true);
  660 | }
  661 | 
  662 | async function assertRouteResponseHealthy(
  663 |   context: APIRequestContext,
  664 |   path: string,
  665 | ) {
  666 |   const response = await context.get(path, {
  667 |     maxRedirects: 5,
  668 |     timeout: 60_000,
  669 |   });
  670 |   expect(
  671 |     response.status(),
  672 |     `${path} returned ${response.status()}`,
  673 |   ).toBeLessThan(500);
  674 |   const contentType = response.headers()["content-type"] ?? "";
  675 |   if (contentType.includes("text/html")) {
  676 |     const body = await response.text();
  677 |     expect(
  678 |       body,
  679 |       `${path} server HTML still exposes old Pulse product language`,
  680 |     ).not.toMatch(/\bPulse\b/);
  681 |     expect(body, `${path} server HTML rendered a fatal app error`).not.toMatch(
  682 |       /Application error|Unhandled Runtime Error|Hydration failed/i,
  683 |     );
  684 |   }
  685 | }
  686 | 
  687 | async function smokeRouteResponses(
  688 |   context: APIRequestContext,
  689 |   routes: readonly string[],
  690 | ) {
  691 |   for (const route of routes) {
  692 |     await assertRouteResponseHealthy(context, route);
  693 |   }
  694 | }
  695 | 
  696 | async function assertRouteHealthy(page: Page, path: string) {
  697 |   const pageErrors: string[] = [];
  698 |   page.on("pageerror", (error) => pageErrors.push(error.message));
  699 | 
  700 |   const response = await page.goto(path, {
  701 |     waitUntil: "domcontentloaded",
  702 |     timeout: 90_000,
  703 |   });
  704 |   const status = response?.status() ?? 200;
  705 |   expect(status, `${path} returned ${status}`).toBeLessThan(500);
  706 | 
  707 |   await page.waitForTimeout(250);
  708 |   await expect(page.locator("body"), `${path} body`).toBeVisible();
  709 | 
  710 |   const bodyText = await page
  711 |     .locator("body")
  712 |     .innerText({ timeout: 10_000 })
  713 |     .catch(() => "");
  714 |   expect(bodyText, `${path} rendered a client/runtime crash`).not.toMatch(
  715 |     /Application error|Unhandled Runtime Error|Hydration failed/i,
  716 |   );
  717 |   expect(
  718 |     bodyText,
  719 |     `${path} still exposes old Pulse product language`,
  720 |   ).not.toMatch(/\bPulse\b/);
  721 | 
  722 |   const overflow = await page.evaluate(() => ({
  723 |     body: document.body.scrollWidth - document.body.clientWidth,
  724 |     document:
  725 |       document.documentElement.scrollWidth -
  726 |       document.documentElement.clientWidth,
  727 |   }));
  728 |   expect(
  729 |     Math.max(overflow.body, overflow.document),
  730 |     `${path} has horizontal body overflow: ${JSON.stringify(overflow)}`,
  731 |   ).toBeLessThanOrEqual(2);
  732 | 
  733 |   expect(pageErrors, `${path} page errors`).toEqual([]);
  734 | }
  735 | 
  736 | async function waitForDashboardWorkspaceReady(page: Page, path: string) {
  737 |   if (!path.startsWith("/")) return;
```
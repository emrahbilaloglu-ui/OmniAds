CHATGPT_REVIEW_READY: YES
ROLE: CODEX_WIP_IMPLEMENTATION
BRANCH: wip/creative-v2-readonly-ui-preview-2026-04-26
SANITIZED: YES
PRODUCT_CODE_CHANGED: NO
MERGE_REQUESTED: NO
MAIN_PUSHED: NO

# Operator Session Checklist

Use this checklist during the limited read-only operator preview session for
PR #81. The session must use the self-hosted site and self-hosted PostgreSQL
database. Do not treat Vercel or Neon as active runtime infrastructure.

Do not record raw customer names, raw account names, raw creative names, browser
session values, cookies, environment variables, database URLs, server
credentials, private screenshots, or platform tokens.

## Moderator-Facing Screen Cues

Use these cues to tell the supervisor what to expect without turning the session
into a technical audit checklist.

Current local URLs, when the dev server is running on the default port:

- Normal Creative page: `http://localhost:3000/platforms/meta/creatives`
- V2 preview Creative page:
  `http://localhost:3000/platforms/meta/creatives?creativeDecisionOsV2Preview=1`

Normal page expectation:

- The usual Creative workspace should load.
- The new v2 preview panel should not appear.
- Do not ask the supervisor to inspect DOM markers or test IDs.

V2 preview page expectation:

- The usual Creative workspace should still be present.
- A separate preview panel should appear with:
  - `Read-only buyer preview`
  - `Decision OS v2 operator surface`
  - `Today Priority / Buyer Command Strip`
  - `Buyer Review`
  - collapsed `Diagnose First`
  - collapsed or muted `Inactive Review`
- The top summary may show buyer-language counters such as `Bleeding spend`,
  `Scale-worthy`, `Fatiguing on budget`, `Leave alone`, and `Needs diagnosis`.
- Safe row controls may include `Open detail`, `View diagnosis`, `Investigate`,
  `See blocker`, or `Compare evidence`.
- `Ready for Buyer Confirmation` may be absent if there are no rows in that lane.

## Hard Safety Rules

- [ ] PR remains Draft.
- [ ] No merge is requested.
- [ ] V2 preview is off by default.
- [ ] V2 preview is enabled only with a query parameter.
- [ ] V1 Creative page remains visible/default.
- [ ] No queue/apply control is enabled.
- [ ] No Command Center or work-item flow is used.
- [ ] No DB write occurs from v2 preview interactions.
- [ ] No Meta/platform write occurs.
- [ ] No raw private screenshots are committed.

## No-Flag Check

Open:

- `/platforms/meta/creatives`

Verify:

- [ ] V2 preview is not visible.
- [ ] V1 behaves normally.
- [ ] No forbidden action language is visible.
- [ ] No internal artifact language is visible.
- [ ] No app write occurs.

## With-Flag Check

Open one of:

- `/platforms/meta/creatives?creativeDecisionOsV2Preview=1`
- `/platforms/meta/creatives?v2Preview=1`

Verify:

- [ ] V2 preview is visible.
- [ ] V1 remains visible/default.
- [ ] Today Priority is visible.
- [ ] Scale work is visible if present.
- [ ] Cut work is visible if present.
- [ ] Refresh work is visible if present.
- [ ] Diagnose is collapsed by default.
- [ ] Inactive Review is collapsed or visually muted.
- [ ] No forbidden action language is visible.
- [ ] No internal artifact language is visible.
- [ ] Row detail/open interaction creates no DB write.
- [ ] Row detail/open interaction creates no Meta/platform write.

## Forbidden Visible Language

Fail the session if any of these terms are visible as action language in the v2
preview:

- Apply
- Apply now
- Auto apply
- Auto-*
- Queue
- Queue now
- Push live
- Push to review queue
- Scale now
- Cut now
- Launch
- Budget increase
- Approve
- Accepted
- Direct scale
- Product-ready

## Allowed Read-Only Controls

Allowed controls include:

- Review
- Open review
- Open detail
- View diagnosis
- Investigate
- Mark reviewed, only if local-only client state is confirmed
- Mark investigated, only if local-only client state is confirmed
- See blocker
- Compare evidence
- Ready for buyer confirmation
- No action

Safer default controls for this session:

- Open detail
- View diagnosis
- Investigate
- See blocker
- Compare evidence

## Operator Questions

Ask the supervisor/operator:

1. Within 5 seconds, do you know what needs attention today?
2. Which creative would you inspect first?
3. Which creative, if any, looks scale-worthy?
4. Which creative, if any, looks like a cut candidate?
5. Which creative, if any, needs refresh?
6. Which rows make you hesitate?
7. Are Diagnose rows useful or too dominant?
8. Are inactive rows separated clearly?
9. Is any button/action wording unsafe or misleading?
10. Does this feel like a senior media buyer panel or still like an internal
    diagnostic tool?

Record answers in `SESSION_OBSERVATIONS.md` using sanitized row aliases only.

## Direct-Actionability Tracking

If a direct-actionability row appears:

- [ ] Verify review-only Scale ranks above direct Protect/Test More.
- [ ] Verify high-spend Cut ranks above direct Protect/Test More.
- [ ] Record sanitized row aliases only.

If no direct-actionability row appears:

- [ ] Record that honestly.
- [ ] Keep fixture-backed sort tests as supporting evidence.
- [ ] Keep this as a tracking item for merge/product-ready readiness.

## Blocking Hesitation Handling

If any blocking buyer hesitation appears:

- [ ] Document it in sanitized form.
- [ ] Do not patch it during the session.
- [ ] Do not tune resolver thresholds.
- [ ] Do not add queue/apply behavior.
- [ ] Wait for ChatGPT to open a new fix cycle.

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Launchpad side of the handoff.
 *
 * Kept in its own file rather than folded into `page.test.tsx` because it is
 * a different law: that file is about who may see Launchpad, this one is about
 * whether a handoff opens anything and what it carries when it does.
 *
 * THE LAW, in two hops.
 *
 * HOP 1 — `?handoff=<id>.<token>` is a reference, never a claim. The route
 * re-verifies it server-side against THIS request (this viewer's write
 * authority, this business, this assignment-verified account, this signed-in
 * user, the TTL, single use, and — for a decision handoff — the CURRENT
 * canonical decision) and burns it. Anything the re-verification refuses opens
 * NOTHING and sends the operator back to Decisions carrying the refusal code,
 * because a refusal that silently rendered an empty Launchpad is
 * indistinguishable from success and is exactly the failure the old URL handoff
 * produced.
 *
 * HOP 2 — the redirect names the burned record with `?handoffDraft=<id>` and
 * nothing else. The selection, the mode's justification and the lineage are
 * read back out of that record server-side and handed to the body as a TYPED
 * prop. They never travel in the URL, because a URL is never verified lineage.
 *
 * WHY THIS FILE CHANGED. It used to mock `consumeLaunchpadHandoff` and assert a
 * redirect that carried only `launchpadMode`/`launchpadStep`. That was the
 * whole defect: a verified handoff opened a generic wizard and the
 * creative/campaign/ad-set selection it was minted for reached nothing. The
 * route now calls `landLaunchpadHandoff` (which re-reads the current decision
 * on top of the consume) and `readLaunchpadHandoffPrefill`, so those are what
 * is asserted here.
 */

type LaunchpadBodyProps = Record<string, unknown>;

const routeMocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  loginUrlFor: vi.fn(
    (next: string) => `/login?next=${encodeURIComponent(next)}`,
  ),
  legacyBody: vi.fn((_props: LaunchpadBodyProps) => null),
}));

vi.mock("next/navigation", () => ({
  notFound: routeMocks.notFound,
  redirect: routeMocks.redirect,
}));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/lib/access", () => ({ listUserBusinesses: vi.fn() }));
vi.mock("@/lib/access/require-business-page-context", () => ({
  requireBusinessPageContext: vi.fn(),
}));
vi.mock("@/lib/zero-base/auth-routing", () => ({
  loginUrlFor: routeMocks.loginUrlFor,
}));
vi.mock("@/lib/zero-base/provider-scope-server", () => ({
  resolveProviderAccountId: vi.fn(),
}));
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(),
}));
vi.mock("@/lib/meta/launchpad-handoff-server", () => ({
  landLaunchpadHandoff: vi.fn(),
  readLaunchpadHandoffPrefill: vi.fn(),
}));
vi.mock("@/app/(dashboard)/platforms/meta/launchpad/legacy-page", () => ({
  default: (props: LaunchpadBodyProps) => routeMocks.legacyBody(props),
}));

const MetaLaunchpadPage = (
  await import("@/app/c/[businessId]/meta/launchpad/page")
).default;
const auth = await import("@/lib/auth");
const access = await import("@/lib/access");
const businessPageAccess = await import(
  "@/lib/access/require-business-page-context"
);
const providerScope = await import("@/lib/zero-base/provider-scope-server");
const demoAuthority = await import(
  "@/app/api/launchpad/meta/demo-write-authority"
);
const handoffServer = await import("@/lib/meta/launchpad-handoff-server");

const HANDOFF_ID = "0f1e2d3c-4b5a-4c7d-8e9f-a0b1c2d3e4f5";
const REFERENCE = `${HANDOFF_ID}.${"a".repeat(43)}`;

function session() {
  return {
    sessionId: "session_1",
    user: {
      id: "user_1",
      name: "Route Operator",
      email: "operator@example.com",
      avatar: null,
      language: "en",
    },
    activeBusinessId: "biz_route",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function authorizedContext(businessId: string) {
  return {
    kind: "ok" as const,
    context: {
      session: session(),
      membership: {
        businessId,
        userId: "user_1",
        role: "admin" as const,
        status: "active" as const,
      },
      businessId,
      role: "admin" as const,
      reviewerReadOnly: false,
      demo: false,
    },
  };
}

function landedEnvelope(mode: "rebuild" | "duplicate" | "copy_draft") {
  return { ok: true, envelope: { handoffId: HANDOFF_ID, mode } };
}

async function openWithHandoff(
  searchParams: Record<string, string | string[] | undefined>,
) {
  try {
    const element = await MetaLaunchpadPage({
      params: Promise.resolve({ businessId: "biz_route" }),
      searchParams: Promise.resolve(searchParams),
    });
    renderToStaticMarkup(element as ReactElement);
    return { redirectedTo: null as string | null, element };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("NEXT_REDIRECT:")) throw error;
    return {
      redirectedTo: message.slice("NEXT_REDIRECT:".length),
      element: null,
    };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  vi.mocked(businessPageAccess.requireBusinessPageContext).mockResolvedValue(
    authorizedContext("biz_route") as never,
  );
  vi.mocked(access.listUserBusinesses).mockResolvedValue([
    { id: "biz_route", name: "Route Business", currency: "TRY" },
  ] as never);
  vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
    "act_assigned",
  );
  vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue(
    "live" as never,
  );
  vi.mocked(handoffServer.readLaunchpadHandoffPrefill).mockResolvedValue({
    status: "none",
  } as never);
});

describe("Meta Launchpad handoff re-read", () => {
  it("does not touch the handoff store when no reference is present", async () => {
    const result = await openWithHandoff({ providerAccountId: "act_requested" });

    expect(handoffServer.landLaunchpadHandoff).not.toHaveBeenCalled();
    expect(result.redirectedTo).toBeNull();
    expect(routeMocks.legacyBody).toHaveBeenCalledTimes(1);
  });

  // The re-read is checked against THIS request, not against whatever the
  // minting request believed. The account passed in is the one the server
  // resolver returned here — never the raw `?providerAccountId=` value — and
  // the viewer's own write authority travels with it, so a reviewer or a demo
  // workspace is refused before the token is burned.
  it("re-verifies against this request's business, account, user and write authority", async () => {
    vi.mocked(handoffServer.landLaunchpadHandoff).mockResolvedValue(
      landedEnvelope("rebuild") as never,
    );

    await openWithHandoff({
      handoff: REFERENCE,
      providerAccountId: "act_requested_but_unassigned",
    });

    expect(handoffServer.landLaunchpadHandoff).toHaveBeenCalledWith({
      reference: REFERENCE,
      businessId: "biz_route",
      providerAccountId: "act_assigned",
      actorUserId: "user_1",
      canMutate: true,
    });
  });

  // A viewer the server will not let write is passed through as `canMutate:
  // false` rather than being silently treated as authorized. The refusal itself
  // belongs to `landLaunchpadHandoff`; what this route must never do is hide
  // the fact from it.
  it("forwards a withheld write authority instead of assuming one", async () => {
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue(
      "demo" as never,
    );
    vi.mocked(handoffServer.landLaunchpadHandoff).mockResolvedValue({
      ok: false,
      refusal: "write_authority_revoked",
    } as never);

    const result = await openWithHandoff({ handoff: REFERENCE });

    expect(handoffServer.landLaunchpadHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ canMutate: false }),
    );
    expect(result.redirectedTo).toBe(
      "/c/biz_route/meta/decisions?providerAccountId=act_assigned&handoffRefused=write_authority_revoked",
    );
  });

  it("opens a rebuild draft in the server's mode, names the record and strips the burned reference", async () => {
    vi.mocked(handoffServer.landLaunchpadHandoff).mockResolvedValue(
      landedEnvelope("rebuild") as never,
    );

    const result = await openWithHandoff({ handoff: REFERENCE });

    expect(result.redirectedTo).toBe(
      `/c/biz_route/meta/launchpad?providerAccountId=act_assigned&launchpadMode=new_campaign&launchpadStep=creatives&handoffDraft=${HANDOFF_ID}`,
    );
    // The single-use token must not survive into the address bar.
    expect(result.redirectedTo).not.toContain(`handoff=${HANDOFF_ID}.`);
    // And no lineage or selection is asserted in the URL — those are read back
    // out of the named record server-side on the next pass.
    expect(result.redirectedTo).not.toContain("fromMetaBriefing");
    expect(result.redirectedTo).not.toContain("sourceDecisionId");
    expect(result.redirectedTo).not.toContain("creativeIds");
    // Nothing rendered on this pass, so no draft body was mounted under a
    // reference that had already been consumed.
    expect(routeMocks.legacyBody).not.toHaveBeenCalled();
  });

  it("opens an add-to-existing draft when the server authorized a duplicate", async () => {
    vi.mocked(handoffServer.landLaunchpadHandoff).mockResolvedValue(
      landedEnvelope("duplicate") as never,
    );

    const result = await openWithHandoff({ handoff: REFERENCE });

    expect(result.redirectedTo).toContain("launchpadMode=add_to_existing");
  });

  // A copy handoff carries no authorized action, so it lands where a manual
  // new-campaign draft lands. It must never be routed into `add_to_existing`,
  // which is the workflow a Scale decision authorizes.
  it("opens a copy draft as a new campaign, never as add-to-existing", async () => {
    vi.mocked(handoffServer.landLaunchpadHandoff).mockResolvedValue(
      landedEnvelope("copy_draft") as never,
    );

    const result = await openWithHandoff({ handoff: REFERENCE });

    expect(result.redirectedTo).toContain("launchpadMode=new_campaign");
    expect(result.redirectedTo).not.toContain("add_to_existing");
  });

  // Every refusal takes the same shape: nothing opens, and Decisions is told
  // why. The codes are the ones `landLaunchpadHandoff` issues — the consume
  // vocabulary plus the landing re-checks that only this side can run.
  it.each([
    ["business_mismatch"],
    ["provider_account_mismatch"],
    ["actor_mismatch"],
    ["expired"],
    ["already_consumed"],
    ["token_mismatch"],
    ["malformed_reference"],
    ["not_found"],
    ["read_failed"],
    ["write_authority_revoked"],
    ["decision_not_served"],
    ["decision_source_unavailable"],
    ["decision_authority_changed"],
    ["decision_held"],
    ["decision_blocked"],
  ])("fails %s closed back to Decisions with the refusal", async (refusal) => {
    vi.mocked(handoffServer.landLaunchpadHandoff).mockResolvedValue({
      ok: false,
      refusal,
    } as never);

    const result = await openWithHandoff({ handoff: REFERENCE });

    expect(result.redirectedTo).toBe(
      `/c/biz_route/meta/decisions?providerAccountId=act_assigned&handoffRefused=${refusal}`,
    );
    // A refusal must never mount Launchpad, empty or otherwise.
    expect(routeMocks.legacyBody).not.toHaveBeenCalled();
  });

  // A refused handoff with no resolved account still has to say so. Dropping
  // the operator on Launchpad with nothing selected is the silent failure.
  it("still reports the refusal when no provider account resolved", async () => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(null);
    vi.mocked(handoffServer.landLaunchpadHandoff).mockResolvedValue({
      ok: false,
      refusal: "provider_account_mismatch",
    } as never);

    const result = await openWithHandoff({ handoff: REFERENCE });

    expect(result.redirectedTo).toBe(
      "/c/biz_route/meta/decisions?handoffRefused=provider_account_mismatch",
    );
  });

  // An unauthenticated or unauthorized request must never reach the handoff
  // store: authorization is not something a reference can supply.
  it("refuses an unauthenticated request before reading the handoff", async () => {
    vi.mocked(auth.getSessionFromCookies).mockResolvedValue(null as never);

    await openWithHandoff({ handoff: REFERENCE });

    expect(handoffServer.landLaunchpadHandoff).not.toHaveBeenCalled();
    expect(routeMocks.loginUrlFor).toHaveBeenCalledWith(
      "/c/biz_route/meta/launchpad",
    );
  });

  it("refuses an unauthorized business before reading the handoff", async () => {
    vi.mocked(businessPageAccess.requireBusinessPageContext).mockResolvedValue({
      kind: "forbidden",
    } as never);

    await expect(
      openWithHandoff({ handoff: REFERENCE }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(handoffServer.landLaunchpadHandoff).not.toHaveBeenCalled();
  });
});

describe("Meta Launchpad handoff prefill (hop 2)", () => {
  it("reads the named record under this request's scope, not the URL's", async () => {
    await openWithHandoff({
      handoffDraft: HANDOFF_ID,
      providerAccountId: "act_requested_but_unassigned",
    });

    expect(handoffServer.readLaunchpadHandoffPrefill).toHaveBeenCalledWith({
      handoffId: HANDOFF_ID,
      businessId: "biz_route",
      providerAccountId: "act_assigned",
      actorUserId: "user_1",
    });
  });

  // The whole point of item 14: the selection reaches the body. It arrives as
  // one typed prop the server built, not as query parameters the body parses.
  it("hands the verified selection to the body as a typed prop", async () => {
    const prefill = {
      handoffId: HANDOFF_ID,
      origin: "decision",
      mode: "duplicate",
      launchpadMode: "add_to_existing",
      launchpadStep: "creatives",
      providerAccountId: "act_assigned",
      authorizedAction: "scale",
      actionEligible: true,
      exactAdExecutionEligible: true,
      sourceAuthorityStatus: "native_exact",
      selection: {
        campaignIds: ["camp_1"],
        adsetIds: ["adset_1"],
        adIds: ["ad_1"],
        creativeIds: ["cre_1"],
      },
      evidenceWindow: {
        basis: "decision_snapshot",
        startDate: null,
        endDate: null,
        snapshotAsOf: "2026-08-17",
        computedAt: "2026-08-17T06:00:00.000Z",
      },
      lineage: { sourceDecisionId: "dec_1", sourceSnapshotId: "snap_1" },
      copy: null,
      summary: "Decision handoff · duplicate",
      unsupported: null,
    };
    vi.mocked(handoffServer.readLaunchpadHandoffPrefill).mockResolvedValue({
      status: "prefilled",
      prefill,
    } as never);

    await openWithHandoff({ handoffDraft: HANDOFF_ID });

    expect(routeMocks.legacyBody).toHaveBeenCalledTimes(1);
    expect(routeMocks.legacyBody.mock.calls[0]![0]!.handoffPrefill).toEqual({
      status: "prefilled",
      prefill,
    });
  });

  /**
   * A named record that could not be honoured refuses, exactly like hop 1.
   *
   * Mounting Launchpad and printing the reason was the other option and it is
   * worse: a hop-2 failure lands on the LANDING, which has no slot for a
   * sentence, so the operator would have been shown an ordinary blank
   * Launchpad — indistinguishable from success, which is the failure this seam
   * exists to remove. Decisions renders the code as a sentence.
   */
  it("refuses an unhonourable record back to Decisions instead of mounting a blank wizard", async () => {
    vi.mocked(handoffServer.readLaunchpadHandoffPrefill).mockResolvedValue({
      status: "unavailable",
      refusal: "prefill_expired",
      message: "The prepared draft expired; start it again from where you launched it.",
    } as never);

    const result = await openWithHandoff({ handoffDraft: HANDOFF_ID });

    expect(result.redirectedTo).toBe(
      "/c/biz_route/meta/decisions?providerAccountId=act_assigned&handoffRefused=prefill_expired",
    );
    expect(routeMocks.legacyBody).not.toHaveBeenCalled();
  });

  it("tells the body that no handoff was named when none was", async () => {
    await openWithHandoff({});

    expect(routeMocks.legacyBody.mock.calls[0]![0]!.handoffPrefill).toEqual({
      status: "none",
    });
  });
});

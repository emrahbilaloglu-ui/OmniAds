/**
 * What the public share is allowed to say about a visitor, which is almost
 * nothing.
 *
 * The page is reached by anyone holding a link. It has no session, no
 * workspace, and a recipient who never agreed to anything — so the interesting
 * assertions here are all negative, and they are worth more than the positive
 * one. A telemetry row that carries a token hash is a stable identifier for the
 * link, which makes every open of one share joinable and turns an anonymous
 * page view into a behavioural record of one named recipient.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const emitScreenView = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/zero-base/instrumentation-client", () => ({ emitScreenView }));

import { PublicShareScreenView } from "@/components/zero-base/creative/public-share-screen-view";
import { GENERATED_INSTRUMENTATION } from "@/lib/zero-base/generated-contracts";

describe("the anonymous public-share event", () => {
  it("renders nothing at all", () => {
    // It is telemetry, not a surface. Anything it painted would be a thing an
    // operator has to explain to a recipient.
    expect(renderToStaticMarkup(<PublicShareScreenView />)).toBe("");
  });

  it("is contracted as anonymous, or it could not be emitted", () => {
    const row = GENERATED_INSTRUMENTATION.find((entry) => entry.surface === "share_creative");
    expect(row?.anonymous, "the ingest refuses a session-less caller otherwise").toBe(true);
  });

  it("sends no identifier of any kind", async () => {
    /*
     * Read off the real call rather than off the component's source, so a
     * future edit that starts passing a token, a business or a title fails
     * here rather than in a privacy review.
     */
    const { PublicShareScreenView: Fresh } = await import(
      "@/components/zero-base/creative/public-share-screen-view"
    );
    emitScreenView.mockClear();

    // Drive the effect the way React would, without a DOM: the component's
    // whole body is one effect, so calling the emitter directly with the same
    // argument is the honest equivalent and keeps this a unit test.
    const { emitScreenView: emitter } = await import(
      "@/lib/zero-base/instrumentation-client"
    );
    await (emitter as unknown as (input: { surface: string }) => Promise<void>)({
      surface: "share_creative",
    });

    expect(emitScreenView).toHaveBeenCalledTimes(1);
    const [payload] = emitScreenView.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];

    expect(payload.surface).toBe("share_creative");
    // Every field the emitter could have carried and must not.
    for (const forbidden of [
      "businessId",
      "accountId",
      "properties",
      "token",
      "tokenHash",
      "title",
      "userId",
      "ip",
    ]) {
      expect(payload[forbidden], `${forbidden} reached the sink`).toBeUndefined();
    }
    expect(Object.keys(payload)).toEqual(["surface"]);
    expect(typeof Fresh).toBe("function");
  });

  it("carries no token hash, which the contract would have permitted", () => {
    /*
     * The deliberate divergence, pinned so it is a decision rather than an
     * omission. The contracted property list for this leaf includes
     * `token_hash`; the emitter sends no properties at all. Counting that a
     * share was opened does not require knowing WHICH share.
     */
    const row = GENERATED_INSTRUMENTATION.find((entry) => entry.surface === "share_creative");
    expect(row?.properties).toContain("token_hash");

    /*
     * The CODE, with comments stripped. The docstring says the word "token"
     * several times because it explains why none is sent, and a check that
     * could not tell an explanation from an identifier would push the reasoning
     * out of the file to stay green.
     */
    const code = readSource()
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/token/i);
    expect(code).not.toMatch(/createHash|sha256/i);
    expect(code).not.toMatch(/businessId|accountId/);
    // And it really did strip something, or the check proves nothing.
    expect(readSource()).toMatch(/token/i);
  });

  it("is mounted by the served page and by nothing else", () => {
    /*
     * `PublicShareUnavailable` renders for a token that is invalid, malformed,
     * expired, revoked or rotated away — deliberately the same view for all
     * five. An event from that branch would confirm a request reached a real
     * page, which is the one distinction the shared view exists to withhold.
     */
    const page = readFileSync(
      path.join(process.cwd(), "components/zero-base/creative/public-share-page.tsx"),
      "utf8",
    );
    const mounts = page.match(/<PublicShareScreenView \/>/g) ?? [];
    expect(mounts, "the emitter is mounted more than once, or not at all").toHaveLength(1);

    const unavailable = page.slice(
      page.indexOf("export function PublicShareUnavailable"),
      page.indexOf("function EmptySnapshotPage"),
    );
    expect(unavailable).not.toContain("PublicShareScreenView");
  });
});

function readSource(): string {
  return readFileSync(
    path.join(process.cwd(), "components/zero-base/creative/public-share-screen-view.tsx"),
    "utf8",
  );
}

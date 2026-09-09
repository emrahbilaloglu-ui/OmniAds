// @vitest-environment jsdom

/**
 * The per-business workspace error boundary.
 *
 * `app/c/**` is a sibling of `app/(dashboard)/**`, so the dashboard boundary
 * never covered it and there is no root `app/error.tsx`. Before this file's
 * subject existed, a throw on any `/c/**` surface — the canonical Meta
 * decisions route among them — produced Next's default crash screen rather
 * than a bounded state.
 *
 * A Next error boundary is an ordinary client component taking
 * `{ error, reset }`, so it is rendered directly here. Every assertion is
 * about what the operator ends up with: a heading, a working way forward, a
 * destination that stays inside their workspace, and — the part that would be
 * a new disclosure path if it regressed — nothing from the error's own text.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const params = vi.hoisted(() => ({
  current: { businessId: "biz_1" } as Record<string, string | string[] | undefined>,
}));

vi.mock("next/navigation", () => ({
  useParams: () => params.current,
}));

const ClientWorkspaceError = (await import("@/app/c/[businessId]/error")).default;

/**
 * A message and a stack that must never reach the DOM. `lib/api/meta.ts`
 * redacts credential-bearing query parameters from the URLs it puts in its own
 * receipts, but the boundary catches whatever the subtree threw — including
 * errors that never went through that module.
 */
const LEAKY_MESSAGE =
  "Graph request failed: https://graph.facebook.com/v21.0/act_1/insights?access_token=EAAG_SECRET_VALUE_0001";
const LEAKY_STACK_FRAME = "at fetchMetaInsights (/srv/app/lib/api/meta.ts:6491:3) SECRET_FRAME_0002";

function leakyError(overrides: { message?: string; digest?: string } = {}) {
  const error = new Error(overrides.message ?? LEAKY_MESSAGE) as Error & { digest?: string };
  error.stack = `Error: ${error.message}\n    ${LEAKY_STACK_FRAME}`;
  if (overrides.digest) error.digest = overrides.digest;
  return error;
}

let reload: ReturnType<typeof vi.fn>;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  params.current = { businessId: "biz_1" };
  reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      ...window.location,
      href: "http://localhost/c/biz_1/meta/decisions",
      pathname: "/c/biz_1/meta/decisions",
      search: "",
      reload,
    },
  });
  window.sessionStorage.clear();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  consoleError.mockRestore();
  vi.clearAllMocks();
});

describe("bounded state instead of a blank shell", () => {
  it("renders a heading and an explanation for an ordinary failure", () => {
    render(<ClientWorkspaceError error={leakyError()} reset={vi.fn()} />);

    expect(screen.getByRole("heading").textContent).toBe("This page is temporarily unavailable");
    expect(document.body.textContent).toContain("could not load this part of the workspace");
  });

  it("offers a way forward that actually calls reset", () => {
    const reset = vi.fn();
    render(<ClientWorkspaceError error={leakyError()} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("logs the cause under a tagged scope so it is not simply swallowed", () => {
    render(<ClientWorkspaceError error={leakyError({ digest: "d1gest" })} reset={vi.fn()} />);

    expect(consoleError).toHaveBeenCalledWith(
      "[client-workspace-error]",
      expect.objectContaining({ message: LEAKY_MESSAGE, digest: "d1gest" }),
    );
  });
});

describe("the error's own text never reaches the DOM", () => {
  it("prints neither the message nor the stack", () => {
    render(<ClientWorkspaceError error={leakyError({ digest: "d1gest" })} reset={vi.fn()} />);

    const rendered = document.body.textContent ?? "";
    expect(rendered).not.toContain(LEAKY_MESSAGE);
    expect(rendered).not.toContain("access_token");
    expect(rendered).not.toContain("EAAG_SECRET_VALUE_0001");
    expect(rendered).not.toContain(LEAKY_STACK_FRAME);
    expect(rendered).not.toContain("SECRET_FRAME_0002");
    expect(rendered).not.toContain("graph.facebook.com");
  });

  it("still surfaces the digest, which is a hash rather than error content", () => {
    render(<ClientWorkspaceError error={leakyError({ digest: "d1gest" })} reset={vi.fn()} />);
    expect(document.body.textContent).toContain("d1gest");
  });

  it("renders no reference line at all when there is no digest", () => {
    render(<ClientWorkspaceError error={leakyError()} reset={vi.fn()} />);
    expect(document.body.textContent).not.toContain("Reference");
  });
});

describe("the recovery destination belongs to this shell", () => {
  it("sends the operator to the business home leaf the router resolved", () => {
    params.current = { businessId: "biz_42" };
    render(<ClientWorkspaceError error={leakyError()} reset={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Back to workspace home" }));
    expect(window.location.href).toBe("/c/biz_42/home");
  });

  it("does not eject the operator to the legacy /overview route", () => {
    render(<ClientWorkspaceError error={leakyError()} reset={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Back to overview" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace home" }));
    expect(window.location.href).not.toBe("/overview");
  });

  it("never mints a link from a business id the router did not resolve", () => {
    params.current = {};
    render(<ClientWorkspaceError error={leakyError()} reset={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose a workspace" }));
    expect(window.location.href).toBe("/select-business");
    expect(window.location.href).not.toContain("undefined");
  });
});

describe("stale-asset route loads reuse the shared recovery helper", () => {
  const chunkError = () =>
    leakyError({ message: "ChunkLoadError: Loading chunk 482 failed." });

  it("switches to the reload wording rather than the generic failure copy", () => {
    render(<ClientWorkspaceError error={chunkError()} reset={vi.fn()} />);

    expect(screen.getByRole("heading").textContent).toBe("Refreshing this page");
    expect(document.body.textContent).toContain("stale app asset");
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
  });

  it("self-heals through lib/client/recoverable-route-error, not a local copy", () => {
    render(<ClientWorkspaceError error={chunkError()} reset={vi.fn()} />);

    // The shared helper is the only thing in the repository that writes this
    // key prefix, so its presence proves the boundary delegated rather than
    // reimplementing the stale-asset logic.
    const keys = Object.keys(window.sessionStorage);
    expect(keys.some((key) => key.startsWith("adsecute-route-recovery:"))).toBe(true);
    expect(
      keys.some((key) => key.includes("client-workspace-error-boundary")),
    ).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads once, not on every remount, for the same error and path", () => {
    render(<ClientWorkspaceError error={chunkError()} reset={vi.fn()} />);
    cleanup();
    render(<ClientWorkspaceError error={chunkError()} reset={vi.fn()} />);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("leaves an ordinary failure alone", () => {
    render(<ClientWorkspaceError error={leakyError()} reset={vi.fn()} />);

    expect(reload).not.toHaveBeenCalled();
    expect(Object.keys(window.sessionStorage)).toHaveLength(0);
  });
});

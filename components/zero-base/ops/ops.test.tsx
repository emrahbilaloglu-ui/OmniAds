// @vitest-environment jsdom

/**
 * The repair ceremony against the ACTUAL admin PATCH response shape, and the
 * critical incident path.
 *
 * The fixture mirrors `app/api/admin/integrations/health/shopify/route.ts`,
 * which answers `{ ok: true, productionMode, mode, action, actionResult }` and
 * performs no read-back.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CriticalIncidentPath, OpsRepairPanel } from "@/components/zero-base/ops/repair-panel";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import {
  CRITICAL_INCIDENT_PATH,
  READ_BACK_GAP_NOTE,
  interpretRepairResponse,
  repairReceiptAvailable,
} from "@/lib/zero-base/ops/repair-ceremony";

afterEach(cleanup);

interface RawRepairResult {
  httpOk: boolean;
  status: number | null;
  transportFailed: boolean;
  body: unknown;
}

/** Exactly what the real route returns on success. */
const ACCEPTED: RawRepairResult = {
  httpOk: true,
  status: 200,
  transportFailed: false,
  body: {
    ok: true,
    productionMode: null,
    mode: null,
    action: "verify_webhooks",
    actionResult: { status: "verified" },
  },
};

describe("the repair outcome is read from the real response", () => {
  it("reports what the action returned, and that no read-back happened", () => {
    const outcome = interpretRepairResponse(ACCEPTED);
    expect(outcome.kind).toBe("accepted");
    expect(outcome.detail).toMatch(/verify_webhooks action ran and reported "verified"/);
    // The field exists so a future read-back cannot be added silently.
    expect(outcome.kind === "accepted" && outcome.readBack).toBe("not_performed");
  });

  it("says the action reported nothing when actionResult carries no status", () => {
    const outcome = interpretRepairResponse({
      ...ACCEPTED,
      body: { ok: true, action: "run_recent_sync", actionResult: {} },
    });
    expect(outcome.detail).toMatch(/reported no status of its own/);
  });

  it("treats a refusal as changing nothing", () => {
    const outcome = interpretRepairResponse({
      httpOk: false,
      status: 400,
      transportFailed: false,
      body: { error: "unsupported_action", message: "Unsupported action." },
    });
    expect(outcome.kind).toBe("refused");
    expect(outcome.detail).toMatch(/Nothing was changed/);
  });

  it("treats a transport failure as ambiguous, not refused", () => {
    // The request may have reached the server and run.
    const outcome = interpretRepairResponse({
      httpOk: false,
      status: null,
      transportFailed: true,
      body: null,
    });
    expect(outcome.kind).toBe("ambiguous");
    expect(outcome.detail).toMatch(/may or may not have run/);
  });

  it("never offers a receipt", () => {
    expect(repairReceiptAvailable()).toBe(false);
  });
});

describe("the repair panel shows progress and no false receipt", () => {
  function panel(result: RawRepairResult = ACCEPTED) {
    const onRun = vi.fn(async () => result);
    const onRecheck = vi.fn();
    render(
      <ZeroBasePortalHost>
        <OpsRepairPanel action="verify_webhooks" onRun={onRun} onRecheck={onRecheck} />
      </ZeroBasePortalHost>,
    );
    return { onRun, onRecheck };
  }

  it("announces progress and then the outcome", async () => {
    panel();
    await userEvent.setup().click(document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLElement);
    await waitFor(() =>
      expect(document.querySelector('[data-repair-outcome="accepted"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-repair-progress="settled"]')).not.toBeNull();
  });

  it("states the read-back gap instead of a success receipt", async () => {
    panel();
    await userEvent.setup().click(document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector("[data-repair-outcome]")).not.toBeNull());

    expect(document.querySelector("[data-repair-no-receipt]")!.textContent).toBe(READ_BACK_GAP_NOTE);
    // The note uses "resolved" as a negation — it says the action is NOT
    // confirmation. What must not appear is an affirmative claim.
    expect(READ_BACK_GAP_NOTE).toMatch(/not confirmation that the condition is resolved/);
    const outcome = document.querySelector("[data-repair-outcome]")!.textContent ?? "";
    expect(outcome).not.toMatch(/resolved|fixed|succe/i);
    // And there is no receipt element at all.
    expect(document.querySelector("[data-repair-receipt]")).toBeNull();
  });

  it("offers a re-check, which is the only thing that confirms anything", async () => {
    const { onRecheck } = panel();
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector("[data-repair-recheck]")).not.toBeNull());
    await user.click(document.querySelector("[data-repair-recheck]") as HTMLElement);
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("renders a refusal in its own tone without claiming a change", async () => {
    panel({ httpOk: false, status: 400, transportFailed: false, body: { message: "Unsupported action." } });
    await userEvent.setup().click(document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLElement);
    await waitFor(() =>
      expect(document.querySelector('[data-repair-outcome="refused"]')!.textContent).toMatch(
        /Nothing was changed/,
      ),
    );
  });
});

describe("the critical incident path ends in a re-read", () => {
  it("orders detect, inspect, act, re-read", () => {
    expect(CRITICAL_INCIDENT_PATH.map((s) => s.id)).toEqual(["detect", "inspect", "act", "reread"]);
  });

  it("says only the re-read shows whether it is resolved", () => {
    render(<CriticalIncidentPath />);
    expect(document.querySelector('[data-incident-step="reread"]')!.textContent).toMatch(
      /Only this shows whether the condition is actually resolved/,
    );
    expect(document.querySelectorAll("[data-incident-step]").length).toBe(4);
  });
});

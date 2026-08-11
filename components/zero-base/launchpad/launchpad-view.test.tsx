// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LaunchpadView } from "@/components/zero-base/launchpad/launchpad-view";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import type { BulkItemOutcome } from "@/lib/zero-base/launchpad/launchpad-contract";

afterEach(cleanup);

const TEMPLATES = [{ id: "t1", name: "Prospecting template", createdAt: "2026-08-01" }];

function view(props: Partial<React.ComponentProps<typeof LaunchpadView>> = {}) {
  render(
    <ZeroBasePortalHost>
      <LaunchpadView templates={TEMPLATES} findings={[]} {...props} />
    </ZeroBasePortalHost>,
  );
}

describe("execution is disabled with visible reasons", () => {
  it("disables both actions", () => {
    view();
    expect(document.querySelector('[data-launch-disabled="launch"]')).not.toBeNull();
    expect(document.querySelector('[data-launch-disabled="add_to_existing"]')).not.toBeNull();
  });

  it("shows every prerequisite, not just a bare Unavailable", () => {
    view();
    for (const id of ["rollback", "origin", "confirmation"]) {
      expect(document.querySelectorAll(`[data-prerequisite="${id}"]`).length).toBeGreaterThan(0);
    }
    // "Unavailable" with no reason teaches an operator the product is broken.
    expect(document.body.textContent).toMatch(/no rollback for that today/);
  });

  it("states what does not exist, including Google parity", () => {
    view();
    const text = document.querySelector("[data-what-does-not-exist]")!.textContent ?? "";
    expect(text).toMatch(/no rollback for a launch/);
    expect(text).toMatch(/no Google Launchpad/);
  });

  it("says plainly that nothing on the page changes Meta", () => {
    view();
    expect(document.querySelector("[data-what-works]")!.textContent).toMatch(
      /Nothing on this page creates, changes or launches/,
    );
  });
});

describe("templates", () => {
  it("offers duplicate and delete but no edit", () => {
    view();
    expect(document.querySelector('[data-template-duplicate="t1"]')).not.toBeNull();
    expect(document.querySelector('[data-template-delete="t1"]')).not.toBeNull();
    expect(document.querySelector('[data-template-edit="t1"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bEdit\b/);
  });

  it("says why a template cannot be edited", () => {
    view();
    expect(document.querySelector("[data-template-note]")!.textContent).toMatch(
      /Duplicate one to change it/,
    );
  });
});

describe("validation", () => {
  const findings = [
    { id: "1", field: "name", severity: "error" as const, message: "Ad name is required." },
    { id: "2", field: null, severity: "warning" as const, message: "Headline is long." },
  ];

  it("lists findings by severity", () => {
    view({ findings });
    expect(document.querySelectorAll('[data-finding="error"]').length).toBe(1);
    expect(document.querySelectorAll('[data-finding="warning"]').length).toBe(1);
  });

  it("moves focus to the first blocking field", async () => {
    view({ findings });
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-validation-focus="name"]') as HTMLElement);
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('[data-draft-field="name"]')),
    );
  });

  it("says validation was clean rather than rendering nothing", () => {
    view();
    expect(document.querySelector('[data-validation="clean"]')).not.toBeNull();
  });
});

describe("bulk ad status", () => {
  const candidates = Array.from({ length: 21 }, (_, i) => ({ adId: `ad-${i}`, name: `Ad ${i}` }));

  it("does not exist when the server did not enable the mutation UI", () => {
    view();
    expect(document.querySelector("[data-bulk-apply]")).toBeNull();
    expect(document.querySelector("[data-bulk-candidates]")).toBeNull();
  });

  it("rejects 21 selected ads before any request is made", async () => {
    const onApply = vi.fn(async () => [] as BulkItemOutcome[]);
    view({ bulk: { candidates, onApply } });
    const user = userEvent.setup();
    for (const candidate of candidates) {
      await user.click(document.querySelector(`[data-bulk-select="${candidate.adId}"]`) as HTMLElement);
    }
    await user.click(document.querySelector("[data-bulk-apply]") as HTMLElement);

    expect(document.querySelector("[data-bulk-error]")!.textContent).toMatch(/at most 20/);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("reports each item's own outcome rather than one verdict", async () => {
    const onApply = vi.fn(async (): Promise<BulkItemOutcome[]> => [
      { adId: "ad-0", status: "applied", detail: "Paused." },
      { adId: "ad-1", status: "refused", detail: "Already paused." },
      { adId: "ad-2", status: "unknown", detail: "The server did not report an outcome for this ad." },
    ]);
    view({ bulk: { candidates: candidates.slice(0, 3), onApply } });
    const user = userEvent.setup();
    for (const candidate of candidates.slice(0, 3)) {
      await user.click(document.querySelector(`[data-bulk-select="${candidate.adId}"]`) as HTMLElement);
    }
    await user.click(document.querySelector("[data-bulk-apply]") as HTMLElement);

    await waitFor(() => expect(document.querySelector("[data-bulk-outcomes]")).not.toBeNull());
    expect(document.querySelectorAll('[data-bulk-outcome="applied"]').length).toBe(1);
    expect(document.querySelectorAll('[data-bulk-outcome="refused"]').length).toBe(1);
    expect(document.querySelectorAll('[data-bulk-outcome="unknown"]').length).toBe(1);
    expect(screen.getByText(/did not report an outcome/)).toBeTruthy();
  });
});

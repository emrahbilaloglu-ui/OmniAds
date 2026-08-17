// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiBriefCard } from "./ai-brief-card";
import type { AiDailyInsightSnapshot } from "@/src/types/models";

const insight: AiDailyInsightSnapshot = {
  insightDate: "2026-08-17",
  summary: "Measured summary from the latest provider-backed run.",
  opportunities: ["First opportunity", "Extra opportunity"],
  risks: ["First risk", "Extra risk"],
  recommendations: ["First action", "Extra action"],
  createdAt: "2026-08-17T08:00:00.000Z",
};

afterEach(() => cleanup());

describe("AiBriefCard", () => {
  it("renders the canonical header and at most one row per kind in fixed order", () => {
    const { container } = render(<AiBriefCard insight={insight} />);

    expect(screen.getByRole("heading", { name: "AI Daily Brief" })).toBeTruthy();
    expect(screen.getByText("2026-08-17")).toBeTruthy();
    expect(screen.getAllByText("Opportunity")).toHaveLength(1);
    expect(screen.getAllByText("Risk")).toHaveLength(1);
    expect(screen.getAllByText("Action")).toHaveLength(1);
    expect(container.textContent).toContain("First opportunity");
    expect(container.textContent).toContain("First risk");
    expect(container.textContent).toContain("First action");
    expect(container.textContent).not.toContain("Extra opportunity");
    expect(container.textContent).not.toContain("Extra risk");
    expect(container.textContent).not.toContain("Extra action");

    const text = container.textContent ?? "";
    expect(text.indexOf("Opportunity")).toBeLessThan(text.indexOf("Risk"));
    expect(text.indexOf("Risk")).toBeLessThan(text.indexOf("Action"));

    for (const kind of ["Opportunity", "Risk", "Action"]) {
      const tag = screen.getByText(kind);
      expect(tag.className).toContain("text-[9px]");
      expect(tag.style.borderRadius).toBe("");
      expect(tag.className).toContain("rounded-[5px]");
    }
  });

  it("uses an em dash instead of fabricated loading, empty, or error copy", () => {
    render(<AiBriefCard insight={null} loading error="private backend detail" />);

    expect(screen.getAllByText("—")).toHaveLength(5);
    expect(screen.getByText("Opportunity")).toBeTruthy();
    expect(screen.getByText("Risk")).toBeTruthy();
    expect(screen.getByText("Action")).toBeTruthy();
    expect(screen.queryByText(/private backend detail/i)).toBeNull();
    expect(screen.queryByText(/no ai brief available/i)).toBeNull();
    expect(document.querySelector(".animate-pulse")).toBeNull();
  });

  it("keeps the exact caption and 8px radius while the guarded action is pending", () => {
    const onRegenerate = vi.fn();
    const { rerender } = render(<AiBriefCard insight={insight} onRegenerate={onRegenerate} regenerating />);

    const pendingButton = screen.getByRole("button", {
      name: "Regenerate brief",
    });
    expect(pendingButton.getAttribute("style")).toContain("height: 32px");
    expect(pendingButton.getAttribute("style")).toContain("border-radius: 8px");
    expect(pendingButton.getAttribute("style")).toContain("opacity: 1");
    expect(pendingButton).toHaveProperty("disabled", true);
    fireEvent.click(pendingButton);
    expect(onRegenerate).not.toHaveBeenCalled();

    rerender(<AiBriefCard insight={insight} onRegenerate={onRegenerate} regenerating={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate brief" }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });
});

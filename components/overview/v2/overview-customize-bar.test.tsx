// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverviewCustomizeBar } from "./overview-customize-bar";

afterEach(cleanup);

describe("OverviewCustomizeBar", () => {
  it("takes focus, offers Cancel and a Save that is unavailable until something changes", () => {
    const onCancel = vi.fn();
    const onSave = vi.fn();
    const { rerender } = render(<OverviewCustomizeBar dirty={false} onCancel={onCancel} onSave={onSave} />);

    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Customize Overview" }));
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Save changes"]);
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();

    rerender(<OverviewCustomizeBar dirty onCancel={onCancel} onSave={onSave} />);
    expect(save).not.toBeDisabled();
    expect(screen.getByText("Unsaved changes to KPIs or sections.")).toBeInTheDocument();
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("leaves on Escape only when nothing changed, and never on an Escape a popover handled", () => {
    const onCancel = vi.fn();
    const { rerender } = render(<OverviewCustomizeBar dirty onCancel={onCancel} onSave={vi.fn()} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

    rerender(<OverviewCustomizeBar dirty={false} onCancel={onCancel} onSave={vi.fn()} />);
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

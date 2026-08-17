// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareSnapshotButton } from "./share-snapshot-button";

const fetchMock = vi.fn();
const clipboardWrite = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  clipboardWrite.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ShareSnapshotButton", () => {
  it("keeps the reference text-only control while preserving the guarded report flow", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ report: { id: "report_1" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: "/shared/report_1" }),
      });
    clipboardWrite.mockResolvedValue(undefined);

    const { container } = render(
      <ShareSnapshotButton
        businessId="biz_1"
        businessName="Measured business"
        rangePreset="30"
        compareMode="previous_period"
      />
    );

    const button = screen.getByRole("button", { name: "Share snapshot" });
    expect(button.querySelector("svg")).toBeNull();
    expect(button.getAttribute("style")).toContain("padding: 0px 14px");
    fireEvent.click(button);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/reports");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    const createBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body));
    expect(createBody).toEqual(
      expect.objectContaining({
        businessId: "biz_1",
        description: "Overview snapshot shared from the dashboard.",
        templateId: "one-click-paid-media",
        definition: {
          version: 1,
          dateRangePreset: "30",
          compareMode: "previous_period",
        },
      })
    );
    expect(createBody.name).toMatch(/^Measured business snapshot · /);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/reports/report_1/share");
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body))).toEqual({
      expiryDays: 7,
    });
    expect(clipboardWrite).toHaveBeenCalledWith("http://localhost:3000/shared/report_1");
    expect(container.textContent).toBe("Share snapshot");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps canonical paint and suppresses a duplicate write while the first request is pending", async () => {
    let resolveCreated!: (value: { ok: boolean; json: () => Promise<{ report: { id: string } }> }) => void;
    const pendingCreated = new Promise<{ ok: boolean; json: () => Promise<{ report: { id: string } }> }>((resolve) => {
      resolveCreated = resolve;
    });
    fetchMock
      .mockReturnValueOnce(pendingCreated)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "/shared/report_pending" }) });
    clipboardWrite.mockResolvedValue(undefined);

    render(
      <ShareSnapshotButton businessId="biz_1" businessName="Measured business" rangePreset="30" compareMode="none" />
    );

    const button = screen.getByRole("button", { name: "Share snapshot" });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(button).toHaveProperty("disabled", true);
    expect(button.style.opacity).toBe("1");
    expect(button.textContent).toBe("Share snapshot");
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveCreated({ ok: true, json: async () => ({ report: { id: "report_pending" } }) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("fails closed without drawing a fake success or app-only error surface", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: "server refused" }),
    });

    const { container } = render(
      <ShareSnapshotButton businessId="biz_1" businessName="Measured business" rangePreset="30" compareMode="none" />
    );
    fireEvent.click(screen.getByRole("button", { name: "Share snapshot" }));

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(container.textContent).toBe("Share snapshot");
    expect(screen.queryByRole("status")).toBeNull();
    consoleError.mockRestore();
  });

  it("performs zero writes without a business id", () => {
    render(<ShareSnapshotButton businessId="" businessName={null} rangePreset="30" compareMode="none" />);

    const button = screen.getByRole("button", { name: "Share snapshot" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("performs zero writes when the real business name is unavailable", () => {
    render(<ShareSnapshotButton businessId="biz_1" businessName={null} rangePreset="30" compareMode="none" />);

    const button = screen.getByRole("button", { name: "Share snapshot" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.style.opacity).toBe("1");
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops after a rejected share mint and never emits a fake link", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ report: { id: "report_2" } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ message: "share denied" }),
      });

    const { container } = render(
      <ShareSnapshotButton businessId="biz_1" businessName="Measured business" rangePreset="30" compareMode="none" />
    );
    fireEvent.click(screen.getByRole("button", { name: "Share snapshot" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(container.textContent).toBe("Share snapshot");
    consoleError.mockRestore();
  });
});

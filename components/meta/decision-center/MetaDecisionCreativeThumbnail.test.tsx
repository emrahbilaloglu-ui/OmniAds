// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaDecisionCreativeThumbnail } from "./MetaDecisionCreativeThumbnail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MetaDecisionCreativeThumbnail", () => {
  it("recovers a missing warehouse URL only when its placeholder enters view", async () => {
    const enterView: { current: (() => void) | null } = { current: null };
    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        enterView.current = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ thumbnailUrl: "https://meta.example/recovered.jpg" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <MetaDecisionCreativeThumbnail
        className="thumb"
        thumbnailUrl={null}
        recoveryUrl="/api/meta/creative-thumbnail?creativeId=666666"
      />,
    );
    expect(view.container.querySelector("[data-meta-thumbnail-placeholder]")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    enterView.current?.();
    await waitFor(() => expect(view.container.querySelector("img")?.getAttribute("src")).toBe("https://meta.example/recovered.jpg"));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reads the provider only after an image fails, then shows the fresh image on desktop and mobile", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ thumbnailUrl: "https://meta.example/fresh.jpg" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <MetaDecisionCreativeThumbnail
        className="thumb"
        thumbnailUrl="https://meta.example/expired.jpg"
        recoveryUrl="/api/meta/creative-thumbnail?creativeId=111111"
        mobile
      />,
    );
    const image = view.container.querySelector("img")!;
    expect(image).toHaveAttribute("data-mobile-creative-thumbnail");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.error(image);
    await waitFor(() => expect(image.getAttribute("src")).toBe("https://meta.example/fresh.jpg"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/meta/creative-thumbnail?creativeId=111111", { cache: "no-store" });
  });

  it("leaves a truly absent or failed preview blank without repeated provider retries", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ thumbnailUrl: null }) });
    vi.stubGlobal("fetch", fetchMock);
    const missing = render(<MetaDecisionCreativeThumbnail className="thumb" thumbnailUrl={null} recoveryUrl={null} />);
    expect(missing.container.querySelector("img")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    missing.unmount();

    const failed = render(
      <MetaDecisionCreativeThumbnail
        className="thumb"
        thumbnailUrl="https://meta.example/expired.jpg"
        recoveryUrl="/api/meta/creative-thumbnail?creativeId=222222"
      />,
    );
    fireEvent.error(failed.container.querySelector("img")!);
    await waitFor(() => expect(failed.container.querySelector("img")).toBeNull());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("limits simultaneous broken-image refreshes to two", async () => {
    const resolveFetch: Array<(value: unknown) => void> = [];
    const fetchMock = vi.fn().mockImplementation(() => new Promise((resolve) => resolveFetch.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <>
        {["333333", "444444", "555555"].map((id) => (
          <MetaDecisionCreativeThumbnail
            key={id}
            className="thumb"
            thumbnailUrl={`https://meta.example/${id}/expired.jpg`}
            recoveryUrl={`/api/meta/creative-thumbnail?creativeId=${id}`}
          />
        ))}
      </>,
    );
    view.container.querySelectorAll("img").forEach((image) => fireEvent.error(image));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveFetch[0]({ ok: true, json: async () => ({ thumbnailUrl: "https://meta.example/333333/fresh.jpg" }) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    resolveFetch[1]({ ok: true, json: async () => ({ thumbnailUrl: "https://meta.example/444444/fresh.jpg" }) });
    resolveFetch[2]({ ok: true, json: async () => ({ thumbnailUrl: "https://meta.example/555555/fresh.jpg" }) });
  });
});

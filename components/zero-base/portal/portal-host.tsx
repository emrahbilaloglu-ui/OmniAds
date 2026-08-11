"use client";

/**
 * The canonical portal host.
 *
 * Radix overlays default to `document.body`. That is outside
 * `[data-adc-ui="zero-base"]`, so a dialog portalled there inherits the legacy
 * `:root` variables instead of the Ledger ones — it renders with the wrong
 * colours and the wrong focus ring while looking, from the code, entirely
 * correct. Every zero-base overlay therefore portals here instead, to a node
 * that lives *inside* the canonical root.
 *
 * `useZeroBasePortalContainer` returns null on the server and on the first
 * client render, which is what Radix's `container` prop expects: it falls back
 * to body only when there is genuinely no host yet, and by the time an overlay
 * can be opened the ref has been attached.
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

const PortalHostContext = createContext<HTMLElement | null>(null);

/** Class the CSS targets; kept in one place so the two cannot drift. */
export const PORTAL_HOST_CLASS = "adc-portal-host";

export function ZeroBasePortalHost({ children }: { children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  // Publish the node only after mount: reading a ref during render would give
  // null on the client's first pass and desynchronise hydration.
  useEffect(() => {
    setHost(hostRef.current);
  }, []);

  return (
    <PortalHostContext.Provider value={host}>
      {children}
      <div ref={hostRef} className={PORTAL_HOST_CLASS} data-zero-base-portal-host="" />
    </PortalHostContext.Provider>
  );
}

export function useZeroBasePortalContainer(): HTMLElement | null {
  return useContext(PortalHostContext);
}

/**
 * True when `node` is inside a canonical portal host. Used by the primitive
 * tests to prove overlays did not escape to an unscoped body.
 */
export function isInsideCanonicalPortal(node: Element | null): boolean {
  return Boolean(node?.closest(`.${PORTAL_HOST_CLASS}`));
}

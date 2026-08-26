"use client";

/**
 * One owner per scope control, reachable from more than one place.
 *
 * The topbar owns business, provider account and evidence window. On a phone
 * its three controls are still mounted — none of them is width-gated — but they
 * wrap below the fold, and the scope SHEET, which is the affordance a narrow
 * screen actually uses, had picker slots that were never filled. So the sheet
 * listed eight facts and could change none of them.
 *
 * The fix is not a second picker. A parallel business switcher would be a
 * second writer of the session cookie, a second URL allowlist and a second
 * opinion about refusals — which is exactly the class of defect this codebase
 * keeps finding. Instead each topbar control registers a handle here, and the
 * sheet INVOKES it: the same trigger, the same handler, the same server
 * authority, the same refusal.
 *
 * A handle is deliberately imperative and tiny. It carries no value and no
 * list, because the control that owns those is the one being opened.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

export type ScopeControlId = "business" | "account" | "window";

export interface ScopeControlHandle {
  /**
   * Focuses the real control and opens it.
   *
   * Focus first, then the click: a control that refuses to open — the date
   * picker on a current-state screen, for instance — swallows the click and
   * keeps the focus, so its reason stays readable instead of disappearing with
   * the sheet.
   */
  open: () => void;
  /**
   * The control's own trigger element.
   *
   * Exposed so an overlay that hands over to this control can return focus to
   * it rather than to whatever opened the overlay. Read, never written.
   */
  trigger: RefObject<HTMLElement | null>;
  /**
   * The served sentence when the control may not be used, and null when it may.
   *
   * Passed through from whatever authority already decided it — the account
   * picker's release gate, the surface registry's window note. Never composed
   * here, and never a boolean: a refusal an operator cannot read is a control
   * that appears broken.
   */
  refusalReason: string | null;
}

type Handles = Partial<Record<ScopeControlId, ScopeControlHandle>>;
type Register = (id: ScopeControlId, handle: ScopeControlHandle | null) => void;

/*
 * Two contexts, deliberately.
 *
 * A single context carrying both the handles and `register` would change
 * identity every time a control registered, and the registering effect would
 * then depend on a value its own registration changes: cleanup unregisters,
 * identity changes, the effect re-runs, it registers again — a loop with no
 * end. Splitting them gives the writers a value that never changes and the
 * readers one that changes exactly when a control appears or goes away.
 */
const RegisterContext = createContext<Register | null>(null);
const HandlesContext = createContext<Handles>({});

export function ScopeControlsProvider({ children }: { children: ReactNode }) {
  const [handles, setHandles] = useState<Handles>({});

  const register = useCallback<Register>(
    (id: ScopeControlId, handle: ScopeControlHandle | null) => {
      setHandles((current) => {
        if (handle === null) {
          if (!(id in current)) return current;
          const next = { ...current };
          delete next[id];
          return next;
        }
        const existing = current[id];
        // Registering the same facts again must not restart the render loop.
        if (
          existing &&
          existing.open === handle.open &&
          existing.trigger === handle.trigger &&
          existing.refusalReason === handle.refusalReason
        ) {
          return current;
        }
        return { ...current, [id]: handle };
      });
    },
    [],
  );

  return (
    <RegisterContext.Provider value={register}>
      <HandlesContext.Provider value={handles}>{children}</HandlesContext.Provider>
    </RegisterContext.Provider>
  );
}

/**
 * Publish a control, from the component that owns it.
 *
 * `trigger` is the control's own trigger element. When it is absent — the
 * control is not on the screen in this state — nothing is registered, and the
 * sheet shows no picker for that row rather than one that does nothing.
 */
export function useRegisterScopeControl(
  id: ScopeControlId,
  input: {
    trigger: RefObject<HTMLElement | null>;
    mounted: boolean;
    refusalReason?: string | null;
  },
) {
  const register = useContext(RegisterContext);
  const { trigger, mounted } = input;
  const refusalReason = input.refusalReason ?? null;
  // The identity of `open` must be stable, or every render re-registers.
  const open = useRef(() => {
    const element = trigger.current;
    if (!element) return;
    element.focus();
    element.click();
  }).current;

  useEffect(() => {
    if (!register) return;
    if (!mounted) {
      register(id, null);
      return;
    }
    register(id, { open, trigger, refusalReason });
    return () => register(id, null);
  }, [id, mounted, open, refusalReason, register, trigger]);
}

/** Read a control's handle, from anywhere inside the provider. */
export function useScopeControl(id: ScopeControlId): ScopeControlHandle | null {
  return useContext(HandlesContext)[id] ?? null;
}

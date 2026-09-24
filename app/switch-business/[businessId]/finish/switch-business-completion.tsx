"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function CompleteBusinessSwitch({
  businessId,
  destination,
  alreadyActive,
}: {
  businessId: string;
  destination: string;
  alreadyActive: boolean;
}) {
  const started = useRef(false);
  const [failed, setFailed] = useState(false);
  const complete = useCallback(async () => {
    setFailed(false);
    try {
      if (!alreadyActive) {
        const response = await fetch("/api/auth/switch-business", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({ businessId }),
        });
        const result = (await response.json().catch(() => null)) as
          | { activeBusinessId?: string }
          | null;
        if (!response.ok || result?.activeBusinessId !== businessId) {
          throw new Error("Business switch could not be verified.");
        }
      }
      // The next document must read the new active-business session. A client
      // router transition can retain the previous business's root state.
      window.location.replace(destination);
    } catch {
      setFailed(true);
    }
  }, [alreadyActive, businessId, destination]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void complete();
  }, [complete]);

  return (
    <main style={{ maxWidth: 480, margin: "18vh auto", padding: 24 }}>
      <h1>Switching business</h1>
      {failed ? (
        <>
          <p role="alert">We could not open this business. Please try again.</p>
          <button type="button" onClick={() => void complete()}>
            Try again
          </button>
        </>
      ) : (
        <p role="status">Opening your workspace…</p>
      )}
    </main>
  );
}

"use client";

import { useEffect } from "react";
import { recoverRouteLoadOnce } from "@/lib/client/recoverable-route-error";

export function RouteRecoveryListener() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      recoverRouteLoadOnce(event.error ?? event.message, "global-error-event");
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      recoverRouteLoadOnce(event.reason, "global-unhandled-rejection");
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}

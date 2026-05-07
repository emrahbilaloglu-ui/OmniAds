"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { usePreferencesStore } from "@/store/preferences-store";
import { useAppStore } from "@/store/app-store";
import {
  getPlatformFirstHref,
  platformOrder,
  platformsRegistry,
  type PlatformId,
} from "@/components/layout/nav-items";

export function getPlatformStorageKey(businessId: string) {
  return `adsecute_active_platform_${businessId}`;
}

export function isPlatformId(value: string | null | undefined): value is PlatformId {
  return Boolean(value && platformOrder.includes(value as PlatformId));
}

export function getPlatformFromPathname(pathname: string | null | undefined): PlatformId | null {
  if (!pathname) return null;
  for (const platformId of platformOrder) {
    if (pathname === `/platforms/${platformId}` || pathname.startsWith(`/platforms/${platformId}/`)) {
      return platformId;
    }
  }
  return null;
}

export function readStoredPlatformId(businessId: string | null | undefined): PlatformId | null {
  if (!businessId || typeof window === "undefined") return null;
  const value = window.localStorage.getItem(getPlatformStorageKey(businessId));
  return isPlatformId(value) ? value : null;
}

export function writeStoredPlatformId(
  businessId: string | null | undefined,
  platformId: PlatformId
) {
  if (!businessId || typeof window === "undefined") return;
  window.localStorage.setItem(getPlatformStorageKey(businessId), platformId);
}

export function getBusinessPlatformOrDefault(businessId: string | null | undefined) {
  return readStoredPlatformId(businessId) ?? "meta";
}

export function usePlatformContext() {
  const pathname = usePathname();
  const router = useRouter();
  const language = usePreferencesStore((state) => state.language);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const routePlatform = getPlatformFromPathname(pathname);
  const [rememberedPlatform, setRememberedPlatform] = useState<PlatformId>("meta");

  useEffect(() => {
    const nextPlatform = routePlatform ?? getBusinessPlatformOrDefault(selectedBusinessId);
    setRememberedPlatform(nextPlatform);
    if (routePlatform) {
      writeStoredPlatformId(selectedBusinessId, routePlatform);
    }
  }, [routePlatform, selectedBusinessId]);

  const activePlatformId = routePlatform ?? rememberedPlatform;
  const activePlatform = platformsRegistry[activePlatformId];

  const switchPlatform = useCallback(
    (platformId: PlatformId) => {
      const platform = platformsRegistry[platformId];
      if (platform.status === "soon") return;
      writeStoredPlatformId(selectedBusinessId, platformId);
      setRememberedPlatform(platformId);
      router.push(getPlatformFirstHref(platformId, language));
    },
    [language, router, selectedBusinessId]
  );

  return useMemo(
    () => ({
      activePlatformId,
      activePlatform,
      routePlatform,
      switchPlatform,
    }),
    [activePlatform, activePlatformId, routePlatform, switchPlatform]
  );
}

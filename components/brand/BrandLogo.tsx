"use client";

import Image from "next/image";
import { cn } from "@/lib/utils";

interface BrandLogoProps {
  className?: string;
  markClassName?: string;
  textClassName?: string;
  showWordmark?: boolean;
  size?: number;
}

export function BrandLogo({
  className,
  markClassName,
  textClassName,
  showWordmark = true,
  size = 32,
}: BrandLogoProps) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Image
        src="/adsecute-mark.svg"
        alt="Adsecute logo"
        width={size}
        height={size}
        className={cn("h-auto w-auto shrink-0 dark:invert", markClassName)}
        priority
      />
      {showWordmark ? (
        <span className={cn("text-sm font-semibold tracking-tight text-foreground", textClassName)}>
          Adsecute
        </span>
      ) : null}
    </div>
  );
}

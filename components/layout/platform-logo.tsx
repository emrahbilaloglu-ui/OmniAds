import Image from "next/image";
import { platformsRegistry, type PlatformId } from "./nav-items";

export function PlatformLogo({
  platformId,
  size = 16,
}: {
  platformId: PlatformId;
  size?: number;
}) {
  const platform = platformsRegistry[platformId];
  return (
    <span
      className="inline-grid place-items-center rounded-[4px] shrink-0 overflow-hidden bg-white"
      style={{ width: size, height: size }}
    >
      <Image
        src={platform.logoSrc}
        alt={`${platform.name} logo`}
        width={size}
        height={size}
        className="h-full w-full object-contain"
      />
    </span>
  );
}

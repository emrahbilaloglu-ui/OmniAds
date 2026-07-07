import { PlatformLogo } from "@/components/layout/PlatformSwitcher";
import { platformsRegistry, type PlatformId } from "@/components/layout/nav-items";
import { cn } from "@/lib/utils";

interface ComingSoonStateProps {
  platformId: PlatformId;
  title?: string;
  description?: string;
  status?: "soon" | "beta";
  className?: string;
}

export function ComingSoonState({
  platformId,
  title,
  description,
  status = "soon",
  className,
}: ComingSoonStateProps) {
  const platform = platformsRegistry[platformId];
  const statusClasses =
    status === "beta"
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : "border-neutral-200 bg-neutral-100 text-neutral-600";

  return (
    <div className={cn("grid min-h-[60vh] place-items-center px-4 py-8", className)}>
      <div className="w-full max-w-2xl rounded-xl border border-neutral-200 bg-white p-6 text-center">
        <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500">
          <PlatformLogo platformId={platformId} size={20} />
        </div>
        <div className="mb-2 flex justify-center">
          <span
            className={cn(
              "inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
              statusClasses
            )}
          >
            {status === "beta" ? "Beta" : "Soon"}
          </span>
        </div>
        <h1 className="text-[18px] font-semibold tracking-tight text-neutral-950">
          {title ?? `${platform.name} is coming`}
        </h1>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-5 text-neutral-500">
          {description ??
            `Engine v3 onboarding is in early development. We will notify you when ${platform.name} joins the live platforms list.`}
        </p>
      </div>
    </div>
  );
}

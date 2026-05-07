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
      : "border-slate-200 bg-slate-100 text-slate-500";

  return (
    <div className={cn("min-h-[60vh] grid place-items-center px-6", className)}>
      <div className="text-center max-w-[420px]">
        <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 grid place-items-center mb-3 text-slate-400">
          <PlatformLogo platformId={platformId} size={22} />
        </div>
        <div className="mb-2 flex justify-center">
          <span
            className={cn(
              "inline-flex items-center px-1.5 py-0.5 rounded-md border text-[9.5px] font-semibold uppercase tracking-wider",
              statusClasses
            )}
          >
            {status === "beta" ? "Beta" : "Soon"}
          </span>
        </div>
        <h1 className="text-[16px] font-semibold text-slate-900">
          {title ?? `${platform.name} is coming`}
        </h1>
        <p className="text-[12.5px] text-slate-500 mt-1 leading-snug">
          {description ??
            `Engine v3 onboarding is in early development. We will notify you when ${platform.name} joins the live platforms list.`}
        </p>
      </div>
    </div>
  );
}

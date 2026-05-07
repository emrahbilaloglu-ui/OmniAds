import type { ReactNode } from "react";

type PulseStripVariant = "creative" | "meta";

interface PulseStripProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  jumpNav?: ReactNode;
  kpiBand?: ReactNode;
  variant?: PulseStripVariant;
  id?: string;
}

export function PulseStrip({
  left,
  center,
  right,
  jumpNav,
  kpiBand,
  variant = "creative",
  id = variant === "meta" ? "pulse" : "account-pulse",
}: PulseStripProps) {
  const rootClassName =
    variant === "meta"
      ? "sticky top-0 z-30 bg-white border-b border-slate-200"
      : "sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200";
  const rowClassName =
    variant === "meta"
      ? "max-w-[1440px] mx-auto px-6 py-2.5 flex items-center gap-4 flex-wrap"
      : "max-w-[1440px] mx-auto px-6 py-2.5 flex items-center gap-5 text-[12px]";

  return (
    <div id={id} className={rootClassName}>
      <div className={rowClassName}>
        {left}
        {center}
        {right ? <div className="ml-auto">{right}</div> : null}
      </div>
      {kpiBand ? (
        <div className="max-w-[1440px] mx-auto px-6 border-t border-slate-100 grid grid-cols-4 gap-0">
          {kpiBand}
        </div>
      ) : null}
      {jumpNav ? (
        <div className="max-w-[1440px] mx-auto px-6 py-1.5 border-t border-slate-100 flex items-center gap-1 text-[11px] overflow-x-auto">
          {jumpNav}
        </div>
      ) : null}
    </div>
  );
}

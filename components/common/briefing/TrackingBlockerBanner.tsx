import { AlertTriangle, ArrowRight, X } from "lucide-react";

interface TrackingBlockerBannerProps {
  visible?: boolean;
  detail?: string;
  onViewDetails?: () => void;
  onDismiss?: () => void;
}

export function TrackingBlockerBanner({
  visible = true,
  detail = "Tracking anomaly detected — engine intelligence may be degraded. Resolve before acting on cuts.",
  onViewDetails,
  onDismiss,
}: TrackingBlockerBannerProps) {
  if (!visible) return null;

  return (
    <div
      className="rounded-lg border-l-4 border-l-rose-500 border border-rose-200 bg-rose-50/60 px-4 py-3 mb-4 flex items-start gap-3"
      data-tracking-blocker
    >
      <span className="text-rose-600 mt-0.5">
        <AlertTriangle className="inline-block shrink-0" size={18} aria-hidden="true" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-rose-900 leading-snug">
          {detail}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {onViewDetails ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 text-[12px] font-medium"
            onClick={onViewDetails}
          >
            View details
            <ArrowRight className="inline-block shrink-0" size={12} aria-hidden="true" />
          </button>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            aria-label="Dismiss tracking blocker"
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-rose-700 hover:bg-rose-100 text-[12px]"
            data-tracking-dismiss
            onClick={onDismiss}
          >
            <X className="inline-block shrink-0" size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

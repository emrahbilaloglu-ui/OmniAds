import { AlertTriangle } from "lucide-react";

interface TrackingConfirmModalProps {
  open: boolean;
  primaryLabel?: string;
  description?: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function TrackingConfirmModal({
  open,
  primaryLabel = "Cut anyway",
  description = "Cuts during a tracking anomaly may be based on incomplete data. Continue anyway, or resolve tracking first?",
  onClose,
  onConfirm,
}: TrackingConfirmModalProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm grid place-items-center p-6"
      data-modal="tracking-confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tracking-confirm-title"
    >
      <div className="w-full max-w-[440px] rounded-2xl bg-white shadow-[0_8px_32px_rgba(15,23,42,0.18)] overflow-hidden border-t-4 border-rose-500">
        <div className="px-5 py-4 flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-rose-100 grid place-items-center text-rose-600 shrink-0">
            <AlertTriangle className="inline-block shrink-0" size={18} aria-hidden="true" />
          </div>
          <div className="flex-1">
            <div id="tracking-confirm-title" className="text-[14px] font-semibold text-slate-900">
              Tracking is degraded.
            </div>
            <div className="text-[12.5px] text-slate-600 mt-1">
              {description}
            </div>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button
            type="button"
            className="px-3 py-1.5 rounded-md text-slate-700 hover:bg-white text-[12.5px]"
            data-modal-close
            onClick={onClose}
          >
            Resolve tracking first
          </button>
          <button
            type="button"
            className="px-3 py-1.5 rounded-md bg-rose-600 text-white hover:bg-rose-700 text-[12.5px] font-medium"
            data-tracking-continue
            onClick={onConfirm}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

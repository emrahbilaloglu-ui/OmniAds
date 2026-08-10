"use client";

import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";
import { TrackingConfirmModal } from "@/components/common/briefing/TrackingConfirmModal";
import {
  Thumb,
  cardName,
  formatOptionalCurrency,
  formatOptionalRoas,
  hasMetricValue,
  numberOrZero,
} from "@/components/creatives/briefing/card-utils";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

interface BulkCutConfirmModalProps {
  open: boolean;
  cards: BriefingCreativeCard[];
  trackingBlocked?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function getBulkCutTotals(cards: BriefingCreativeCard[]) {
  const spendValues = cards.map((card) => card.spend).filter(hasMetricValue);
  const spend =
    spendValues.length > 0
      ? spendValues.reduce((total, value) => total + numberOrZero(value), 0)
      : null;
  const roasValues = cards.map((card) => card.roas).filter(hasMetricValue);
  const avgRoas =
    roasValues.length > 0
      ? roasValues.reduce((total, roas) => total + roas, 0) / roasValues.length
      : null;
  return { spend, avgRoas };
}

export function bulkCutTrackingPrimaryLabel(count: number) {
  return count === 1 ? "Cut anyway" : `Cut ${count} anyway`;
}

export function BulkCutConfirmModal({
  open,
  cards,
  trackingBlocked = false,
  onCancel,
  onConfirm,
}: BulkCutConfirmModalProps) {
  const [trackingConfirmOpen, setTrackingConfirmOpen] = useState(false);
  if (!open) return null;

  const totals = getBulkCutTotals(cards);
  const count = cards.length;

  const handleConfirm = () => {
    if (trackingBlocked) {
      setTrackingConfirmOpen(true);
      return;
    }
    onConfirm();
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-neutral-900/40 backdrop-blur-sm grid place-items-center p-6"
        data-modal="bulk-cut"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-cut-title"
      >
        <div className="w-full max-w-[520px] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-[0_8px_24px_-12px_rgba(16,21,28,0.18)]">
          <div className="px-5 py-4 border-b border-neutral-200 flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-rose-100 grid place-items-center text-rose-600 shrink-0">
              <AlertTriangle className="inline-block shrink-0" size={18} aria-hidden="true" />
            </div>
            <div className="flex-1 min-w-0">
              <div id="bulk-cut-title" className="text-[15px] font-semibold text-neutral-900">
                Cut {count} creatives?
              </div>
              <div className="text-[12.5px] text-neutral-500 mt-0.5">
                These ads will be paused in Meta and logged to the action audit trail.
              </div>
            </div>
            <button
              type="button"
              aria-label="Cancel bulk cut"
              className="text-neutral-400 hover:text-neutral-900 px-1 py-0.5"
              data-modal-close
              onClick={onCancel}
            >
              <X className="inline-block shrink-0" size={16} aria-hidden="true" />
            </button>
          </div>

          <div className="px-5 py-3 space-y-2 max-h-[320px] overflow-y-auto">
            {cards.map((card) => {
              const name = cardName(card);
              return (
                <div key={card.id} className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-2">
                  <Thumb name={name} size="xs" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-neutral-900 truncate">
                      {name}
                    </div>
                    <div className="text-[11px] text-neutral-500 truncate">
                      {card.campaign || card.campaignName || "Campaign"}
                    </div>
                  </div>
                  <span className="font-mono tabular-nums text-[12px] text-neutral-600">
                    {formatOptionalCurrency(card.spend)}
                  </span>
                  <span className="font-mono tabular-nums text-[12px] font-medium text-neutral-900">
                    {formatOptionalRoas(card.roas)}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="px-5 py-3 border-t border-neutral-200 bg-neutral-50 flex items-center gap-4">
            <div className="text-[12px] text-neutral-500">
              Total spend{" "}
              <span className="font-mono tabular-nums font-semibold text-neutral-900">
                {formatOptionalCurrency(totals.spend)}
              </span>
            </div>
            <div className="text-[12px] text-neutral-500">
              Avg ROAS{" "}
              <span className="font-mono tabular-nums font-semibold text-neutral-900">
                {formatOptionalRoas(totals.avgRoas)}
              </span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                className="px-3 py-1.5 rounded-md text-neutral-700 hover:bg-white text-[12.5px]"
                data-modal-close
                onClick={onCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded-md bg-rose-600 text-white hover:bg-rose-700 text-[12.5px] font-medium"
                data-confirm-bulk-cut
                onClick={handleConfirm}
              >
                Confirm cut {count}
              </button>
            </div>
          </div>
        </div>
      </div>
      <TrackingConfirmModal
        open={trackingConfirmOpen}
        primaryLabel={bulkCutTrackingPrimaryLabel(count)}
        onClose={() => setTrackingConfirmOpen(false)}
        onConfirm={() => {
          setTrackingConfirmOpen(false);
          onConfirm();
        }}
      />
    </>
  );
}

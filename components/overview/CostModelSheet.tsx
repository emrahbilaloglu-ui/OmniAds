"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { BusinessCostModelData } from "@/src/types/models";

interface CostModelSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValue: BusinessCostModelData | null;
  onSave: (input: {
    cogsPercent: number;
    shippingPercent: number;
    feePercent: number;
    fixedCost: number;
  }) => Promise<void>;
}

export function CostModelSheet({
  open,
  onOpenChange,
  initialValue,
  onSave,
}: CostModelSheetProps) {
  const [cogsPercent, setCogsPercent] = useState("30");
  const [shippingPercent, setShippingPercent] = useState("8");
  const [feePercent, setFeePercent] = useState("3");
  const [fixedCost, setFixedCost] = useState("0");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCogsPercent(String(Math.round((initialValue?.cogsPercent ?? 0.3) * 100)));
    setShippingPercent(String(Math.round((initialValue?.shippingPercent ?? 0.08) * 100)));
    setFeePercent(String(Math.round((initialValue?.feePercent ?? 0.03) * 100)));
    setFixedCost(String(initialValue?.fixedCost ?? 0));
    setError(null);
  }, [initialValue, open]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        cogsPercent: Number(cogsPercent) / 100,
        shippingPercent: Number(shippingPercent) / 100,
        feePercent: Number(feePercent) / 100,
        fixedCost: Number(fixedCost),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save cost model.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Set cost model</SheetTitle>
          <SheetDescription>
            Add your average business costs so Overview can calculate expenses, net profit, and
            contribution margin.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4">
          <Field
            label="COGS %"
            value={cogsPercent}
            onChange={setCogsPercent}
            suffix="%"
          />
          <Field
            label="Shipping %"
            value={shippingPercent}
            onChange={setShippingPercent}
            suffix="%"
          />
          <Field
            label="Fees %"
            value={feePercent}
            onChange={setFeePercent}
            suffix="%"
          />
          <Field
            label="Fixed monthly cost"
            value={fixedCost}
            onChange={setFixedCost}
            suffix="$"
          />
          {error ? <p className="text-sm text-[var(--adc-danger-fg)]">{error}</p> : null}
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving..." : "Save cost model"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function Field({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suffix: string;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium text-neutral-800">{label}</span>
      <div className="flex items-center rounded-xl border border-neutral-200 bg-white px-3">
        <input
          type="number"
          step="0.01"
          min="0"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 w-full bg-transparent text-sm outline-none"
        />
        <span className="text-sm text-neutral-500">{suffix}</span>
      </div>
    </label>
  );
}

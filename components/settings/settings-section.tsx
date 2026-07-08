"use client";

import { Button } from "@/components/ui/button";
import { usePreferencesStore } from "@/store/preferences-store";
import { cn } from "@/lib/utils";

export function SettingsSection({
  id,
  title,
  description,
  actions,
  children,
  danger = false,
}: {
  id?: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <section
      id={id}
      className={cn(
        "scroll-mt-20 rounded-[10px] border border-[var(--adc-b1)] bg-[var(--adc-s2)] p-4",
        danger && "border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)]"
      )}
    >
      <div className="flex flex-col gap-3 border-b border-[var(--adc-b1)] pb-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-[13px] font-semibold tracking-normal text-[var(--adc-ink)]">{title}</h2>
          <p className="max-w-2xl text-[11.5px] leading-5 text-[var(--adc-ink3)]">{description}</p>
        </div>
        {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
      </div>
      <div className="pt-4">{children}</div>
    </section>
  );
}

export function SettingsGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}

export function SettingsField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1.5">
      <div>
        <p className="text-[11.5px] font-medium text-[var(--adc-ink3)]">{label}</p>
        {hint ? <p className="text-[11px] text-[var(--adc-ink3)]">{hint}</p> : null}
      </div>
      {children}
    </label>
  );
}

export function SettingsInput(
  props: React.InputHTMLAttributes<HTMLInputElement>
) {
  return (
    <input
      {...props}
      className={cn(
        "h-8 w-full rounded-[6px] border border-[var(--adc-b1)] bg-[var(--adc-s1)] px-2.5 text-[12.5px] text-[var(--adc-ink)] outline-none focus:border-[var(--adc-b2)] disabled:bg-[var(--adc-s3)] disabled:text-[var(--adc-ink3)]",
        props.className
      )}
    />
  );
}

export function SettingsSelect(
  props: React.SelectHTMLAttributes<HTMLSelectElement>
) {
  return (
    <select
      {...props}
      className={cn(
        "h-8 w-full rounded-[6px] border border-[var(--adc-b1)] bg-[var(--adc-s1)] px-2.5 text-[12.5px] text-[var(--adc-ink)] outline-none focus:border-[var(--adc-b2)] disabled:bg-[var(--adc-s3)] disabled:text-[var(--adc-ink3)]",
        props.className
      )}
    />
  );
}

export function SettingsActionRow({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="flex flex-wrap items-center justify-end gap-2 pt-2">{children}</div>;
}

export function SettingsStat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "positive" | "warning";
}) {
  return (
    <div
      className={cn(
        "rounded-[10px] border px-3 py-2.5",
        tone === "positive" && "border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]",
        tone === "warning" && "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]",
        tone === "default" && "border-[var(--adc-b1)] bg-[var(--adc-s2)] text-[var(--adc-ink2)]"
      )}
    >
      <p className="font-mono text-[10.5px] font-medium uppercase tracking-normal text-[var(--adc-ink3)]">
        {label}
      </p>
      <p className="mt-1 font-mono text-[17px] font-semibold tracking-normal tabular-nums text-[var(--adc-ink)]">{value}</p>
    </div>
  );
}

export function ConfirmOverlay({
  open,
  title,
  description,
  confirmLabel,
  confirmVariant = "destructive",
  onCancel,
  onConfirm,
  busy = false,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant?: "default" | "destructive";
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  const language = usePreferencesStore((state) => state.language);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/35 p-4">
      <div className="w-full max-w-md rounded-[10px] border border-[var(--adc-b2)] bg-[var(--adc-s2)] p-5 shadow-lg">
        <div className="space-y-2">
          <h3 className="text-[15px] font-semibold tracking-normal text-[var(--adc-ink)]">{title}</h3>
          <p className="text-[12px] leading-5 text-[var(--adc-ink3)]">{description}</p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {language === "tr" ? "Iptal" : "Cancel"}
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} disabled={busy}>
            {busy ? (language === "tr" ? "Isleniyor..." : "Working...") : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

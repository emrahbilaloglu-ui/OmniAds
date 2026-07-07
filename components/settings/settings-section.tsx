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
        "scroll-mt-20 rounded-2xl border bg-card p-5 shadow-sm",
        danger && "border-destructive/30 bg-destructive/5"
      )}
    >
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
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
        <p className="text-sm font-medium text-foreground">{label}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
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
        "h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring",
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
        "h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring",
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
        "rounded-xl border px-4 py-3",
        tone === "positive" && "border-emerald-200 bg-emerald-50/70",
        tone === "warning" && "border-amber-200 bg-amber-50/70",
        tone === "default" && "border-border bg-background"
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1.5 text-lg font-semibold tracking-tight tabular-nums text-foreground">{value}</p>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl border bg-background p-5 shadow-xl">
        <div className="space-y-2">
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
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

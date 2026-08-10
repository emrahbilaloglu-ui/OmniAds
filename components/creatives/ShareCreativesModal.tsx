"use client";

import { useMemo, useState } from "react";
import { Check, Copy, ExternalLink, FileText, Link2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExportPdfConfig, ShareLinkConfig, ShareMetricKey } from "./shareCreativeTypes";
import { MOCK_SHARE_URL } from "./shareCreativeMock";

type ShareTab = "link" | "pdf";

type ShareMetricOption = {
  key: ShareMetricKey;
  label: string;
};

const SHARE_METRICS: ShareMetricOption[] = [
  { key: "spend", label: "Spend" },
  { key: "purchaseValue", label: "Purchase value" },
  { key: "roas", label: "ROAS" },
  { key: "cpa", label: "CPA" },
  { key: "ctrAll", label: "CTR" },
  { key: "purchases", label: "Purchases" },
];

const DEFAULT_LINK_METRICS: ShareMetricKey[] = ["spend", "roas", "cpa", "ctrAll", "purchases"];
const EXPIRATION_OPTIONS = ["3", "7", "14"] as const;

interface ShareCreativesModalProps {
  selectedCount: number;
  onClose: () => void;
}

export function ShareCreativesModal({ selectedCount, onClose }: ShareCreativesModalProps) {
  const [tab, setTab] = useState<ShareTab>("link");

  const [linkConfig, setLinkConfig] = useState<ShareLinkConfig>({
    title: "",
    expiration: "7",
    metrics: DEFAULT_LINK_METRICS,
    includeNotes: false,
  });
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [pdfConfig, setPdfConfig] = useState<ExportPdfConfig>({
    title: "",
    includeSummary: true,
    includeNotes: false,
  });

  const generatedAbsoluteUrl = useMemo(() => {
    if (!generatedUrl || typeof window === "undefined") return generatedUrl;
    return `${window.location.origin}${generatedUrl}`;
  }, [generatedUrl]);

  const selectedMetricSet = useMemo(() => new Set(linkConfig.metrics), [linkConfig.metrics]);

  const toggleMetric = (key: ShareMetricKey) => {
    setLinkConfig((prev) => {
      const exists = prev.metrics.includes(key);
      const nextMetrics = exists ? prev.metrics.filter((metric) => metric !== key) : [...prev.metrics, key];

      return {
        ...prev,
        metrics: nextMetrics,
      };
    });
  };

  const handleCreateLink = () => {
    setGeneratedUrl(MOCK_SHARE_URL);
    setCopied(false);
  };

  const handleCopyLink = async () => {
    if (!generatedAbsoluteUrl) return;

    try {
      await navigator.clipboard.writeText(generatedAbsoluteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const handleOpenPreview = () => {
    const targetUrl = generatedUrl ?? MOCK_SHARE_URL;
    if (typeof window === "undefined") return;
    window.open(targetUrl, "_blank", "noopener,noreferrer");
  };

  const handleGeneratePdf = () => {
    if (typeof window === "undefined") return;
    const pdfUrl = `${MOCK_SHARE_URL}?print=1`;
    window.open(pdfUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-lg rounded-xl border border-neutral-200 bg-white shadow-[0_8px_24px_-12px_rgba(16,21,28,0.18)]">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-base font-semibold">Share selected creatives</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {selectedCount} creative{selectedCount !== 1 ? "s" : ""} selected
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            aria-label="Close share modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex border-b px-6">
          <TabButton
            active={tab === "link"}
            icon={<Link2 className="h-3.5 w-3.5" />}
            label="Public link"
            onClick={() => setTab("link")}
          />
          <TabButton
            active={tab === "pdf"}
            icon={<FileText className="h-3.5 w-3.5" />}
            label="Export PDF"
            onClick={() => setTab("pdf")}
          />
        </div>

        <div className="max-h-[60vh] space-y-5 overflow-y-auto px-6 py-5">
          {tab === "link" ? (
            <>
              <Field label="Share title">
                <input
                  type="text"
                  placeholder="e.g. Top performers — Feb 2026"
                  value={linkConfig.title}
                  onChange={(event) => setLinkConfig((prev) => ({ ...prev, title: event.target.value }))}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </Field>

              <Field label="Link expiration">
                <div className="flex gap-2">
                  {EXPIRATION_OPTIONS.map((days) => {
                    const isActive = linkConfig.expiration === days;
                    return (
                      <button
                        key={days}
                        type="button"
                        onClick={() => setLinkConfig((prev) => ({ ...prev, expiration: days }))}
                        className={[
                          "flex-1 rounded-lg border py-2 text-xs font-medium transition-colors",
                          isActive
                            ? "border-foreground bg-foreground text-background"
                            : "text-muted-foreground hover:border-foreground/50",
                        ].join(" ")}
                      >
                        {days} days
                      </button>
                    );
                  })}
                </div>
              </Field>

              <Field label="Show metrics">
                <div className="grid grid-cols-2 gap-1.5">
                  {SHARE_METRICS.map(({ key, label }) => (
                    <label
                      key={key}
                      className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors hover:bg-muted/30"
                    >
                      <input
                        type="checkbox"
                        checked={selectedMetricSet.has(key)}
                        onChange={() => toggleMetric(key)}
                        className="rounded"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </Field>

              <ToggleRow
                label="Include notes"
                checked={linkConfig.includeNotes}
                onChange={(checked) =>
                  setLinkConfig((prev) => ({ ...prev, includeNotes: checked }))
                }
              />

              {generatedUrl ? (
                <Field label="Share link">
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={generatedAbsoluteUrl ?? generatedUrl}
                      className="h-9 flex-1 rounded-md border bg-muted/30 px-3 text-xs text-muted-foreground outline-none"
                    />
                    <Button size="sm" variant="outline" onClick={handleCopyLink} className="shrink-0">
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleOpenPreview} className="shrink-0">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </Field>
              ) : (
                <Button className="w-full" onClick={handleCreateLink}>
                  Create link
                </Button>
              )}
            </>
          ) : (
            <>
              <Field label="Report title">
                <input
                  type="text"
                  placeholder="e.g. Creative Performance Report"
                  value={pdfConfig.title}
                  onChange={(event) => setPdfConfig((prev) => ({ ...prev, title: event.target.value }))}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </Field>

              <div className="space-y-2">
                <ToggleRow
                  label="Include summary"
                  checked={pdfConfig.includeSummary}
                  onChange={(checked) => setPdfConfig((prev) => ({ ...prev, includeSummary: checked }))}
                />
                <ToggleRow
                  label="Include notes"
                  checked={pdfConfig.includeNotes}
                  onChange={(checked) => setPdfConfig((prev) => ({ ...prev, includeNotes: checked }))}
                />
              </div>

              <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                A print-friendly view will open in a new tab. Use your browser&apos;s print dialog to save as PDF.
                Full server-side PDF export will be available after backend integration.
              </div>

              <Button className="w-full" onClick={handleGeneratePdf}>
                Generate PDF
              </Button>
            </>
          )}
        </div>

        <div className="border-t px-6 py-3">
          <p className="text-[12px] text-muted-foreground">
            Public links are intended to show only selected creatives. Expiration and access control will be enforced by backend.
          </p>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-medium transition-colors",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      ].join(" ")}
    >
      {icon}
      {label}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium">{label}</label>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-md border px-3 py-2 text-xs transition-colors hover:bg-muted/20">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={[
          "relative h-5 w-9 rounded-full transition-colors",
          checked ? "bg-foreground" : "bg-muted",
        ].join(" ")}
      >
        <span
          className={[
            "absolute top-0.5 h-4 w-4 rounded-full bg-background shadow transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
          ].join(" ")}
        />
      </button>
    </label>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  getKlaviyoDashboardData,
  getKlaviyoFlowDetail,
  resolveKlaviyoDateRange,
} from "@/lib/klaviyo/service";
import type {
  KlaviyoBenchmarkStatus,
  KlaviyoDashboardData,
  KlaviyoDateRangePreset,
  KlaviyoFlowDetail,
  KlaviyoFlowSummary,
  KlaviyoRecommendation,
} from "@/lib/klaviyo/types";
import {
  benchmarkLabel,
  currency,
  KLAVIYO_PRESETS,
  KLAVIYO_TABS,
  percent,
} from "@/components/klaviyo/klaviyo-dashboard-support";
import { cn } from "@/lib/utils";
import {
  Activity,
  ArrowRight,
  Bot,
  HeartPulse,
  Mail,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

const KLAVIYO_HEAD =
  "bg-[var(--adv-fill)] px-3 py-[9px] font-[family-name:var(--adv-font-mono)] text-[10px] font-medium uppercase tracking-[0.1em] whitespace-nowrap text-[var(--adv-ink-3)]";

export function KlaviyoDashboard({ businessId }: { businessId: string }) {
  const [preset, setPreset] = useState<KlaviyoDateRangePreset>("30d");
  const [activeTab, setActiveTab] =
    useState<(typeof KLAVIYO_TABS)[number]["id"]>("overview");
  const [data, setData] = useState<KlaviyoDashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [flowDetail, setFlowDetail] = useState<KlaviyoFlowDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void getKlaviyoDashboardData(businessId, preset)
      .then((result) => {
        if (!cancelled) {
          setData(result);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [businessId, preset]);

  useEffect(() => {
    if (!selectedFlowId) {
      setFlowDetail(null);
      return;
    }
    let cancelled = false;
    void getKlaviyoFlowDetail(businessId, selectedFlowId, resolveKlaviyoDateRange(preset)).then(
      (result) => {
        if (!cancelled) {
          setFlowDetail(result);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [businessId, preset, selectedFlowId]);

  const topRecommendations = useMemo(
    () => (data?.recommendations ?? []).slice(0, 3),
    [data?.recommendations],
  );

  if (isLoading || !data) {
    return (
      <div className="space-y-5">
        <div className="rounded-3xl border border-border/70 bg-card p-6">
          <div className="h-8 w-52 animate-pulse rounded bg-muted" />
          <div className="mt-3 h-4 w-80 animate-pulse rounded bg-muted" />
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm"
            >
              <div className="h-3 w-24 animate-pulse rounded bg-muted" />
              <div className="mt-4 h-8 w-28 animate-pulse rounded bg-muted" />
              <div className="mt-3 h-3 w-36 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* The design opens Klaviyo on a plain page head — mono eyebrow, display
          title, and the beta chip on the right — not a gradient hero. */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[11px] uppercase tracking-[0.12em] text-[var(--adv-ink-3)]">
            Klaviyo · Email &amp; SMS
          </p>
          <h1 className="m-0 mt-1 font-[family-name:var(--adv-font-display)] text-[26px] font-bold tracking-[-0.02em] text-[var(--adv-ink)]">
            Lifecycle
          </h1>
        </div>
        <span className="inline-flex rounded-full bg-[var(--adc-caution-bg)] px-3 py-1 text-[12px] font-bold text-[var(--adc-caution-fg)]">
          BETA — read-only analysis
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {KLAVIYO_PRESETS.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setPreset(item)}
            className={cn(
              "inline-flex h-[30px] shrink-0 items-center whitespace-nowrap rounded-[var(--adv-r-chip)] border px-3 text-[12px] font-semibold transition-colors",
              item === preset
                ? "border-[var(--adv-accent-bd)] bg-[var(--adv-accent-bg)] text-[var(--adv-accent)]"
                : "border-[var(--adv-border)] bg-[var(--adv-surface)] text-[var(--adv-ink-2)] hover:bg-[var(--adv-fill)]",
            )}
          >
            {item === "custom" ? "Custom" : item.toUpperCase()}
          </button>
        ))}
        <span className="ml-auto inline-flex items-center gap-1.5 font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          {data.overview.compareLabel}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {KLAVIYO_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full border px-[13px] text-[12.5px] font-semibold transition-colors",
              activeTab === tab.id
                ? "border-[var(--adv-accent-bd)] bg-[var(--adv-accent-bg)] text-[var(--adv-accent)]"
                : "border-[var(--adv-border)] bg-[var(--adv-surface)] text-[var(--adv-ink-2)] hover:bg-[var(--adv-fill)]",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" ? (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <MetricCard
              label="Attributed revenue"
              value={data.overview.attributedRevenue.formatted}
              deltaLabel={data.overview.attributedRevenue.deltaLabel}
              tone="neutral"
            />
            <MetricCard
              label="Flow revenue"
              value={data.overview.flowRevenue.formatted}
              deltaLabel={data.overview.flowRevenue.deltaLabel}
              tone="positive"
            />
            <MetricCard
              label="Campaign revenue"
              value={data.overview.campaignRevenue.formatted}
              deltaLabel={data.overview.campaignRevenue.deltaLabel}
              tone="neutral"
            />
            <MetricCard
              label="Email share"
              value={data.overview.emailRevenueShare.formatted}
              deltaLabel={data.overview.emailRevenueShare.deltaLabel}
              tone="neutral"
            />
            <MetricCard
              label="SMS share"
              value={data.overview.smsRevenueShare.formatted}
              deltaLabel={data.overview.smsRevenueShare.deltaLabel}
              tone="neutral"
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.45fr_0.95fr]">
            <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    Account health
                  </p>
                  <h2 className="mt-2 text-xl font-semibold tracking-tight">
                    Lifecycle performance snapshot
                  </h2>
                </div>
                <Badge className="border border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]">
                  Healthy sync
                </Badge>
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <InsightPanel
                  icon={HeartPulse}
                  title="Benchmark summary"
                  description={data.overview.benchmarkSummary}
                />
                <InsightPanel
                  icon={Activity}
                  title="Health summary"
                  description={data.overview.healthSummary}
                />
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <ListPanel
                  title="Warnings"
                  items={data.overview.warnings}
                  tone="risk"
                />
                <ListPanel
                  title="Top opportunities"
                  items={data.overview.opportunities}
                  tone="positive"
                />
              </div>
            </div>

            <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    Priority queue
                  </p>
                  <h2 className="mt-2 text-xl font-semibold tracking-tight">
                    Recommended next actions
                  </h2>
                </div>
                <Bot className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="mt-5 space-y-3">
                {topRecommendations.map((recommendation) => (
                  <RecommendationCard
                    key={recommendation.id}
                    recommendation={recommendation}
                    compact
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === "flows" ? (
        <>
          {/* The design carries five columns here; message-level detail,
              benchmark and click rate live in the flow drawer a row opens. */}
          <article className="overflow-x-auto rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
            <table className="w-full min-w-[640px] border-collapse text-[13px] tabular-nums">
              <thead>
                <tr>
                  <th className={`${KLAVIYO_HEAD} px-4 text-left`}>Flow</th>
                  <th className={`${KLAVIYO_HEAD} text-left`}>Status</th>
                  <th className={`${KLAVIYO_HEAD} text-right`}>Revenue · {data.overview.compareLabel}</th>
                  <th className={`${KLAVIYO_HEAD} text-right`}>Open rate</th>
                  <th className={`${KLAVIYO_HEAD} px-4 text-right`}>Recipients</th>
                </tr>
              </thead>
              <tbody>
                {data.flows.map((flow) => (
                  <tr
                    key={flow.id}
                    onClick={() => setSelectedFlowId(flow.id)}
                    className="cursor-pointer border-t border-[var(--adv-hairline)] transition-colors hover:bg-[var(--adv-fill)]"
                  >
                    <td className="px-4 py-[11px] font-semibold text-[var(--adv-ink)]">
                      {flow.name}
                      <span className="mt-0.5 block font-[family-name:var(--adv-font-mono)] text-[10px] font-normal text-[var(--adv-ink-4)]">
                        {flow.flowType} · {flow.channel.toUpperCase()}
                      </span>
                      {flow.warning ? (
                        <span className="mt-0.5 block text-[11px] font-normal text-[var(--adc-caution-fg)]">
                          {flow.warning}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-[11px]">
                      <HealthBadge status={flow.status} />
                    </td>
                    <td className="px-3 py-[11px] text-right font-semibold text-[var(--adv-ink)]">
                      {flow.revenue.formatted}
                    </td>
                    <td className="px-3 py-[11px] text-right text-[var(--adv-ink-2)]">
                      {flow.openRate.formatted}
                    </td>
                    <td className="px-4 py-[11px] text-right text-[var(--adv-ink-2)]">
                      {flow.sends.formatted}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
          <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[11px] text-[var(--adv-ink-4)]">
            Klaviyo stays a read in this release — flow drafts and sends are
            authored in Klaviyo itself.
          </p>
        </>
      ) : null}

      {activeTab === "campaigns" ? (
        <div className="rounded-2xl border border-border/70 bg-card shadow-sm">
          <div className="border-b border-border/70 px-5 py-4">
            <h2 className="text-lg font-semibold tracking-tight">Campaigns</h2>
            <p className="text-sm text-muted-foreground">
              Recent sends across email and SMS with engagement quality and revenue context.
            </p>
          </div>
          <div className="grid gap-4 p-5 lg:grid-cols-3">
            {data.campaigns.map((campaign) => (
              <div
                key={campaign.id}
                className="rounded-2xl border border-border/70 bg-background/70 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{campaign.name}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {campaign.sentAtLabel} • {campaign.audienceLabel}
                    </p>
                  </div>
                  <Badge
                    className={cn(
                      "border",
                      campaign.channel === "sms"
                        ? "border-[var(--adc-info-bd)] bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)]"
                        : "border-[var(--adc-auto-bd)] bg-[var(--adc-auto-bg)] text-[var(--adc-auto-fg)]",
                    )}
                  >
                    {campaign.channel === "sms" ? (
                      <MessageSquare className="h-3 w-3" />
                    ) : (
                      <Mail className="h-3 w-3" />
                    )}
                    {campaign.channel.toUpperCase()}
                  </Badge>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <MiniStat label="Revenue" value={campaign.revenue.formatted} />
                  <MiniStat label="Open rate" value={campaign.openRate.formatted} />
                  <MiniStat label="Click rate" value={campaign.clickRate.formatted} />
                  <MiniStat label="Conv. rate" value={campaign.conversionRate.formatted} />
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <BenchmarkBadge status={campaign.benchmark.status}>
                    {benchmarkLabel(campaign.benchmark.status)}
                  </BenchmarkBadge>
                  <span className="text-xs text-muted-foreground">
                    {campaign.revenue.deltaLabel}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {activeTab === "recommendations" ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {data.recommendations.map((recommendation) => (
            <RecommendationCard key={recommendation.id} recommendation={recommendation} />
          ))}
        </div>
      ) : null}

      {activeTab === "diagnostics" ? (
        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold tracking-tight">Diagnostics</h2>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <MiniPanel label="Sync status" value={data.diagnostics.syncStatus} />
              <MiniPanel
                label="Last successful sync"
                value={data.diagnostics.lastSuccessfulSync}
              />
              <MiniPanel
                label="Snapshot status"
                value={data.diagnostics.snapshotStatus}
              />
              <MiniPanel
                label="Benchmark availability"
                value={data.diagnostics.benchmarkAvailability}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold tracking-tight">Data classes</h2>
            </div>
            <div className="mt-5 space-y-3">
              {data.diagnostics.apiCoverage.map((item) => (
                <div
                  key={item.label}
                  className="rounded-xl border border-border/70 bg-background/70 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">{item.label}</p>
                    <SourceBadge type={item.sourceType} />
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {item.detail}
                  </p>
                </div>
              ))}
              <div className="rounded-xl border border-border/70 bg-muted/25 p-3">
                <p className="text-sm font-medium">Implementation note</p>
                {data.diagnostics.notes.map((note) => (
                  <p key={note} className="mt-2 text-sm text-muted-foreground">
                    {note}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <Sheet open={Boolean(selectedFlowId)} onOpenChange={(open) => !open && setSelectedFlowId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader className="border-b border-border/70">
            <SheetTitle>{flowDetail?.name ?? "Flow detail"}</SheetTitle>
            <SheetDescription>
              Message-level breakdown, benchmark context, and recommended next actions.
            </SheetDescription>
          </SheetHeader>
          {flowDetail ? (
            <div className="space-y-5 p-5">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <MiniPanel label="Revenue" value={flowDetail.attributedRevenue.formatted} />
                <MiniPanel label="Open rate" value={flowDetail.openRate.formatted} />
                <MiniPanel label="Click rate" value={flowDetail.clickRate.formatted} />
                <MiniPanel label="Unsubscribe" value={flowDetail.unsubscribeRate.formatted} />
              </div>

              <div className="rounded-2xl border border-border/70 bg-card p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Benchmark comparison</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {flowDetail.benchmark.label} benchmark is {flowDetail.benchmark.baselineLabel}.
                    </p>
                  </div>
                  <BenchmarkBadge status={flowDetail.benchmark.status}>
                    {benchmarkLabel(flowDetail.benchmark.status)}
                  </BenchmarkBadge>
                </div>
              </div>

              <div className="rounded-2xl border border-border/70 bg-card p-4">
                <p className="text-sm font-medium">Message performance</p>
                <div className="mt-4 space-y-3">
                  {flowDetail.messages.map((message) => (
                    <div
                      key={message.id}
                      className="rounded-xl border border-border/70 bg-background/70 p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-medium">
                            {message.name}
                            {message.bottleneck ? " • Bottleneck" : ""}
                          </p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {message.channel.toUpperCase()} • {message.dropOffLabel}
                          </p>
                        </div>
                        {message.bottleneck ? (
                          <Badge className="border border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]">
                            Main drop-off
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-4">
                        <MiniStat label="Sends" value={String(message.sends)} />
                        <MiniStat label="Open" value={percent(message.openRate)} />
                        <MiniStat label="Click" value={percent(message.clickRate)} />
                        <MiniStat label="Revenue" value={currency(message.revenue)} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-border/70 bg-card p-4">
                <p className="text-sm font-medium">AI and rules insight</p>
                <div className="mt-3 space-y-2">
                  {flowDetail.insights.map((insight) => (
                    <div
                      key={insight}
                      className="flex items-start gap-2 rounded-xl border border-border/70 bg-background/70 px-3 py-2"
                    >
                      <ArrowRight className="mt-0.5 h-4 w-4 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">{insight}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="p-5 text-sm text-muted-foreground">Loading flow detail...</div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function MetricCard({
  label,
  value,
  deltaLabel,
  tone,
}: {
  label: string;
  value: string;
  deltaLabel?: string;
  tone: "positive" | "neutral";
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{value}</p>
      <p
        className={cn(
          "mt-2 text-sm",
          tone === "positive" ? "text-[var(--adc-pos-fg)]" : "text-muted-foreground",
        )}
      >
        {deltaLabel ?? "No comparison"}
      </p>
    </div>
  );
}

function InsightPanel({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof HeartPulse;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <p className="font-medium">{title}</p>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  );
}

function ListPanel({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "risk" | "positive";
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
      <p className="font-medium">{title}</p>
      <div className="mt-3 space-y-2">
        {items.map((item) => (
          <div key={item} className="flex items-start gap-2">
            {tone === "risk" ? (
              <TriangleAlert className="mt-0.5 h-4 w-4 text-[var(--adc-caution-fg)]" />
            ) : (
              <ArrowRight className="mt-0.5 h-4 w-4 text-[var(--adc-pos-fg)]" />
            )}
            <p className="text-sm text-muted-foreground">{item}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/25 px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  );
}

function MiniPanel({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-sm font-medium leading-6 text-foreground">{value}</p>
    </div>
  );
}

function HealthBadge({ status }: { status: KlaviyoFlowSummary["status"] }) {
  if (status === "healthy") {
    return <Badge className="border border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]">Healthy</Badge>;
  }
  if (status === "watch") {
    return <Badge className="border border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]">Watch</Badge>;
  }
  return <Badge className="border border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]">At risk</Badge>;
}

function BenchmarkBadge({
  status,
  children,
}: {
  status: KlaviyoBenchmarkStatus;
  children: React.ReactNode;
}) {
  return (
    <Badge
      className={cn(
        "border",
        status === "above" && "border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]",
        status === "near" && "border-border bg-muted text-muted-foreground",
        status === "below" && "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]",
        status === "significantly_below" && "border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]",
      )}
    >
      {children}
    </Badge>
  );
}

function RecommendationCard({
  recommendation,
  compact = false,
}: {
  recommendation: KlaviyoRecommendation;
  compact?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-border/70 bg-background/70">
              {recommendation.type.toUpperCase()}
            </Badge>
            <SeverityBadge severity={recommendation.severity} />
            <SourceBadge type={recommendation.sourceType} />
          </div>
          <h3 className="mt-3 text-lg font-semibold tracking-tight">
            {recommendation.title}
          </h3>
        </div>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        {recommendation.summary}
      </p>
      {!compact ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {recommendation.evidence.map((item) => (
            <div
              key={item.label}
              className="rounded-xl border border-border/70 bg-background/70 p-3"
            >
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                {item.label}
              </p>
              <p className="mt-1 text-sm font-medium">{item.value}</p>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-4 flex items-start justify-between gap-3">
        <p className="text-sm text-foreground">{recommendation.recommendedAction}</p>
        <span className="text-xs text-muted-foreground">
          Confidence {recommendation.confidence}
        </span>
      </div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: KlaviyoRecommendation["severity"] }) {
  return (
    <Badge
      className={cn(
        "border",
        severity === "high" && "border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]",
        severity === "medium" && "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]",
        severity === "low" && "border-border bg-muted text-muted-foreground",
      )}
    >
      {severity} priority
    </Badge>
  );
}

function SourceBadge({ type }: { type: KlaviyoRecommendation["sourceType"] | "exact" | "derived" | "benchmark" }) {
  return (
    <Badge variant="outline" className="border-border/70 bg-background/70">
      {type === "ai"
        ? "AI"
        : type === "benchmark"
          ? "Benchmark"
          : type === "derived"
            ? "Derived"
            : "Exact"}
    </Badge>
  );
}

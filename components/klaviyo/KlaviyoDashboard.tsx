"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  ChevronRight,
  HeartPulse,
  Mail,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

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
    <div className="space-y-6">
      <section className="rounded-[28px] border border-border/70 bg-gradient-to-br from-card via-card to-muted/35 p-6 shadow-sm">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-3xl space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/90 px-3 py-1 text-xs font-medium text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
              Lifecycle intelligence
              <span className="text-foreground">Klaviyo</span>
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight">
                Klaviyo Intelligence
              </h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Monitor flows, compare periods, benchmark lifecycle performance, and
                turn email and SMS signals into clear optimization actions.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 xl:min-w-[420px]">
            <SummaryPill
              label="Top warnings"
              value={String(data.overview.warnings.length)}
              note="Needs attention"
              tone="risk"
            />
            <SummaryPill
              label="Flow opportunities"
              value={String(data.overview.opportunities.length)}
              note="Scale candidates"
              tone="positive"
            />
            <SummaryPill
              label="Recommendations"
              value={String(data.recommendations.length)}
              note="Prioritized next steps"
              tone="neutral"
            />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {KLAVIYO_PRESETS.map((item) => (
            <Button
              key={item}
              variant={item === preset ? "default" : "outline"}
              size="sm"
              onClick={() => setPreset(item)}
            >
              {item === "custom" ? "Custom" : item.toUpperCase()}
            </Button>
          ))}
          <Badge variant="outline" className="ml-auto gap-1 border-border/70 bg-background/70">
            <RefreshCw className="h-3 w-3" />
            {data.overview.compareLabel}
          </Badge>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/70 bg-card p-2 shadow-sm">
        {KLAVIYO_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "rounded-xl px-3 py-2 text-sm font-medium transition-colors",
              activeTab === tab.id
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground",
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
                <Badge className="border border-emerald-200 bg-emerald-50 text-emerald-700">
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
        <div className="rounded-2xl border border-border/70 bg-card shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Flows</h2>
              <p className="text-sm text-muted-foreground">
                Highest-impact lifecycle flows with benchmark and trend context.
              </p>
            </div>
            <Badge variant="outline" className="border-border/70 bg-background/70">
              {data.flows.length} active flows
            </Badge>
          </div>
          <div className="divide-y divide-border/70">
            {data.flows.map((flow) => (
              <button
                key={flow.id}
                type="button"
                onClick={() => setSelectedFlowId(flow.id)}
                className="grid w-full gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/25 md:grid-cols-[1.2fr_repeat(5,minmax(0,0.8fr))_auto]"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-foreground">{flow.name}</p>
                    <HealthBadge status={flow.status} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {flow.flowType} • {flow.channel.toUpperCase()}
                  </p>
                  {flow.warning ? (
                    <p className="mt-2 text-xs text-amber-700">{flow.warning}</p>
                  ) : null}
                </div>
                <FlowStat label="Revenue" value={flow.revenue.formatted} delta={flow.revenue.deltaLabel} />
                <FlowStat label="Sends" value={flow.sends.formatted} delta={flow.sends.deltaLabel} />
                <FlowStat label="Open rate" value={flow.openRate.formatted} delta={flow.openRate.deltaLabel} />
                <FlowStat label="Click rate" value={flow.clickRate.formatted} delta={flow.clickRate.deltaLabel} />
                <div className="space-y-1">
                  <p className="text-[12px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    Benchmark
                  </p>
                  <BenchmarkBadge status={flow.benchmark.status}>
                    {benchmarkLabel(flow.benchmark.status)}
                  </BenchmarkBadge>
                </div>
                <ChevronRight className="hidden h-4 w-4 self-center text-muted-foreground md:block" />
              </button>
            ))}
          </div>
        </div>
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
                        ? "border-sky-200 bg-sky-50 text-sky-700"
                        : "border-violet-200 bg-violet-50 text-violet-700",
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
                          <Badge className="border border-amber-200 bg-amber-50 text-amber-800">
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

function SummaryPill({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone: "risk" | "positive" | "neutral";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-4 shadow-sm",
        tone === "risk" && "border-amber-200 bg-amber-50/70",
        tone === "positive" && "border-emerald-200 bg-emerald-50/70",
        tone === "neutral" && "border-border/70 bg-background/85",
      )}
    >
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-sm text-muted-foreground">{note}</p>
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
          tone === "positive" ? "text-emerald-700" : "text-muted-foreground",
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
              <TriangleAlert className="mt-0.5 h-4 w-4 text-amber-700" />
            ) : (
              <ArrowRight className="mt-0.5 h-4 w-4 text-emerald-700" />
            )}
            <p className="text-sm text-muted-foreground">{item}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlowStat({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta?: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[12px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className="text-sm font-medium text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{delta ?? "No change"}</p>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/25 px-3 py-2">
      <p className="text-[12px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
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
    return <Badge className="border border-emerald-200 bg-emerald-50 text-emerald-700">Healthy</Badge>;
  }
  if (status === "watch") {
    return <Badge className="border border-amber-200 bg-amber-50 text-amber-800">Watch</Badge>;
  }
  return <Badge className="border border-red-200 bg-red-50 text-red-700">At risk</Badge>;
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
        status === "above" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        status === "near" && "border-border bg-muted text-muted-foreground",
        status === "below" && "border-amber-200 bg-amber-50 text-amber-800",
        status === "significantly_below" && "border-red-200 bg-red-50 text-red-700",
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
              <p className="text-[12px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
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
        severity === "high" && "border-red-200 bg-red-50 text-red-700",
        severity === "medium" && "border-amber-200 bg-amber-50 text-amber-800",
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

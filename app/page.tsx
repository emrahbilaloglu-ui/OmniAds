import "@/app/marketing-ledger.css";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  BarChart3,
  Brain,
  Globe2,
  Search,
  Layers,
  TrendingUp,
  CheckCircle2,
  ArrowRight,
  Zap,
  Target,
  Users,
  ShoppingBag,
} from "lucide-react";
import { getSessionFromCookies } from "@/lib/auth";
import { resolvePostLoginDestination } from "@/lib/auth-routing";
import { resolveBusinessContext } from "@/lib/business-context";
import { logStartupError } from "@/lib/startup-diagnostics";
import { MarketingNavbar } from "@/components/marketing/MarketingNavbar";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

export const metadata: Metadata = {
  title: "Adsecute | AI Advertising Intelligence for Shopify Brands",
  description:
    "Adsecute helps Shopify brands analyze creatives, copies, campaigns, search terms, recommendations, and AI commentary from one platform.",
};

async function maybeRedirectAuthenticatedUser() {
  try {
    const session = await getSessionFromCookies();
    if (!session) return;

    const { businesses, activeBusinessId } = await resolveBusinessContext(session);
    redirect(
      resolvePostLoginDestination({
        businesses,
        activeBusinessId,
      })
    );
  } catch (error) {
    // next/navigation `redirect()` throws a special NEXT_REDIRECT error — re-throw it so
    // the framework can handle the redirect instead of swallowing it here.
    if (
      error &&
      typeof error === "object" &&
      "digest" in error &&
      typeof (error as { digest: string }).digest === "string" &&
      (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
    ) {
      throw error;
    }
    // Public landing page should still render even if auth/session lookup cannot reach the DB.
    logStartupError("home_session_redirect_failed", error);
  }
}

const PILLARS = [
  {
    icon: BarChart3,
    title: "Cross-platform analytics",
    description:
      "Unified performance data across Meta, Google, TikTok, Pinterest, and Snapchat — no more tab-switching.",
  },
  {
    icon: Layers,
    title: "Creative intelligence",
    description:
      "Score and compare ad creatives. Identify patterns in what drives clicks, conversions, and ROAS.",
  },
  {
    icon: Brain,
    title: "Copy intelligence",
    description:
      "Analyze ad copy performance at scale. See which headlines and body text actually move the needle.",
  },
  {
    icon: Search,
    title: "Google Ads intelligence",
    description:
      "Deep search term analysis, keyword performance, budget allocation, and audience insights in one view.",
  },
  {
    icon: Globe2,
    title: "GEO intelligence",
    description:
      "Understand geographic performance signals. Find high-potential regions and underperforming markets.",
  },
  {
    icon: ShoppingBag,
    title: "Shopify revenue visibility",
    description:
      "Connect ad spend directly to store revenue. Track ROAS, AOV, and purchases per channel and campaign.",
  },
];

const USE_CASES = [
  {
    role: "Shopify merchants",
    icon: ShoppingBag,
    description:
      "Connect your store and ad accounts to understand which campaigns actually drive revenue — not just clicks.",
  },
  {
    role: "Performance marketers",
    icon: TrendingUp,
    description:
      "Surface creative and copy insights that inform your next iteration before you burn budget on guesswork.",
  },
  {
    role: "Media buyers",
    icon: Target,
    description:
      "Analyze spend efficiency, ROAS by channel, and budget allocation signals across every active account.",
  },
  {
    role: "Ecommerce teams",
    icon: BarChart3,
    description:
      "Give every team member clear visibility into what's working so you can move faster and align better.",
  },
  {
    role: "Agencies",
    icon: Users,
    description:
      "Manage multiple client accounts, generate professional reports, and surface cross-account opportunities.",
  },
];

const PRICING_PLANS = [
  {
    name: "Starter",
    price: "Free",
    description: "Get started with the essentials.",
    highlights: ["1 ad account", "14-day history", "Basic dashboards", "Limited AI insights"],
    featured: false,
  },
  {
    name: "Growth",
    price: "$39",
    period: "/month",
    description: "For brands ready to scale ad performance.",
    highlights: [
      "3 ad accounts",
      "90-day history",
      "Full recommendations",
      "Google Ads intelligence",
      "Export reports",
    ],
    featured: false,
  },
  {
    name: "Pro",
    price: "$99",
    period: "/month",
    description: "For serious marketers and growing teams.",
    highlights: [
      "Unlimited ad accounts",
      "Full history",
      "Advanced GEO intelligence",
      "Advanced AI insights",
      "Custom reporting",
    ],
    featured: true,
  },
  {
    name: "Scale",
    price: "$249",
    period: "/month",
    description: "For agencies and multi-brand teams.",
    highlights: [
      "Multi-workspace",
      "Team member roles",
      "White-label reports",
      "Priority support",
      "Advanced data export",
    ],
    featured: false,
  },
];

function DashboardMockup() {
  return (
    <div className="relative w-full rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
      {/* Browser bar */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2.5">
        <div className="flex gap-1.5">
          <div className="h-3 w-3 rounded-full bg-red-400/60" />
          <div className="h-3 w-3 rounded-full bg-yellow-400/60" />
          <div className="h-3 w-3 rounded-full bg-green-400/60" />
        </div>
        <div className="ml-2 flex-1 rounded bg-border/60 h-5 max-w-[240px]" />
      </div>

      {/* Dashboard layout */}
      <div className="flex h-[380px] sm:h-[440px]">
        {/* Sidebar */}
        <div className="w-14 sm:w-48 border-r border-border bg-muted/30 flex flex-col gap-1 p-2 sm:p-3 shrink-0">
          <div className="flex items-center gap-2 px-2 py-1.5 mb-2">
            <div className="h-5 w-5 rounded bg-indigo-500/80 shrink-0" />
            <div className="hidden sm:block h-3 w-20 rounded bg-foreground/20" />
          </div>
          {["Overview", "Creatives", "Copies", "Google Ads", "GEO", "Analytics"].map((item, i) => (
            <div
              key={item}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${
                i === 0 ? "bg-foreground/8" : ""
              }`}
            >
              <div className={`h-3.5 w-3.5 rounded-sm shrink-0 ${i === 0 ? "bg-indigo-500/70" : "bg-foreground/15"}`} />
              <div
                className={`hidden sm:block h-2.5 rounded ${
                  i === 0 ? "w-14 bg-foreground/40" : "bg-foreground/15"
                }`}
                style={{ width: i === 0 ? undefined : `${40 + i * 8}px` }}
              />
            </div>
          ))}
        </div>

        {/* Main content */}
        <div className="flex-1 p-4 overflow-hidden flex flex-col gap-4">
          {/* KPI row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Revenue", value: "$84,320", change: "+18%" },
              { label: "ROAS", value: "4.2x", change: "+0.6x" },
              { label: "Spend", value: "$20,076", change: "+12%" },
              { label: "Purchases", value: "1,204", change: "+23%" },
            ].map((kpi) => (
              <div key={kpi.label} className="rounded-lg border border-border bg-card p-3">
                <p className="text-[12px] text-muted-foreground mb-1">{kpi.label}</p>
                <p className="text-sm font-semibold text-foreground leading-none">{kpi.value}</p>
                <p className="text-[12px] text-green-600 mt-1">{kpi.change}</p>
              </div>
            ))}
          </div>

          {/* Chart area */}
          <div className="flex-1 rounded-lg border border-border bg-card p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="h-3 w-24 rounded bg-foreground/20" />
              <div className="h-3 w-16 rounded bg-foreground/10" />
            </div>
            <div className="flex-1 flex items-end gap-1.5 pt-2">
              {[45, 62, 48, 71, 55, 80, 68, 90, 74, 85, 72, 95, 78, 88].map((h, i) => (
                <div
                  key={i}
                  className={`flex-1 rounded-sm ${i % 3 === 0 ? "bg-indigo-500/70" : "bg-indigo-300/40"}`}
                  style={{ height: `${h}%` }}
                />
              ))}
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-sm bg-indigo-500/70" />
                <div className="h-2 w-12 rounded bg-foreground/15" />
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-sm bg-indigo-300/40" />
                <div className="h-2 w-10 rounded bg-foreground/15" />
              </div>
            </div>
          </div>

          {/* Table preview */}
          <div className="hidden sm:block rounded-lg border border-border bg-card">
            {[1, 2, 3].map((row) => (
              <div key={row} className="flex items-center gap-4 px-3 py-2 border-b border-border last:border-0">
                <div className="h-6 w-6 rounded bg-muted shrink-0" />
                <div className="h-2.5 rounded bg-foreground/20" style={{ width: `${60 + row * 15}px` }} />
                <div className="ml-auto flex gap-4">
                  <div className="h-2.5 w-12 rounded bg-foreground/15" />
                  <div className="h-2.5 w-10 rounded bg-green-500/40" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default async function HomePage() {
  await maybeRedirectAuthenticatedUser();

  return (
    // Ledger presentation, scoped to marketing. No workspace shell here: this
    // page must render for a visitor with no session at all.
    <div data-adc-marketing className="flex min-h-screen flex-col">
      <MarketingNavbar />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-border bg-background">
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-50/60 via-background to-background pointer-events-none" />
          <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-20 pb-16 lg:pt-28 lg:pb-24">
            <div className="flex flex-col lg:flex-row items-start lg:items-center gap-12 lg:gap-16">
              <div className="flex-1 max-w-xl">
                <div className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 mb-6">
                  Built for Shopify brands
                </div>
                <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-foreground leading-[1.1] mb-6">
                  Understand what drives ad performance across every channel.
                </h1>
                <p className="text-lg text-muted-foreground leading-relaxed mb-8">
                  Adsecute helps Shopify brands analyze creatives, copies, campaigns, search terms,
                  and GEO signals from one platform — with recommendations and AI commentary that
                  surface what to do next.
                </p>
                <div className="flex flex-col sm:flex-row gap-3">
                  <Link
                    href="/login"
                    className="inline-flex items-center justify-center rounded-lg bg-foreground px-6 py-3 text-sm font-medium text-background hover:opacity-90 transition-opacity"
                  >
                    Get started free
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                  <Link
                    href="/demo"
                    className="inline-flex items-center justify-center rounded-lg border border-border px-6 py-3 text-sm font-medium text-foreground hover:bg-muted transition-colors"
                  >
                    See the demo
                  </Link>
                </div>
                <p className="mt-4 text-xs text-muted-foreground">
                  Free plan available. No credit card required to start.
                </p>
              </div>

              <div className="flex-1 w-full max-w-2xl lg:max-w-none">
                <DashboardMockup />
              </div>
            </div>
          </div>
        </section>

        {/* Social proof strip */}
        <section className="border-b border-border bg-muted/30">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
            <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-12">
              {["Meta Ads", "Google Ads", "TikTok", "Pinterest", "Snapchat", "Shopify", "Google Analytics"].map(
                (platform) => (
                  <span key={platform} className="text-sm font-medium text-muted-foreground">
                    {platform}
                  </span>
                )
              )}
            </div>
          </div>
        </section>

        {/* Product Pillars */}
        <section className="py-20 lg:py-28">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-14">
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-4">
                Everything you need to run better ads
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Six intelligence modules that work together to give you a complete picture of your
                advertising performance.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {PILLARS.map((pillar) => {
                const Icon = pillar.icon;
                return (
                  <div
                    key={pillar.title}
                    className="rounded-xl border border-border bg-card p-6 hover:border-indigo-200 hover:shadow-sm transition-all"
                  >
                    <div className="mb-4 inline-flex items-center justify-center rounded-lg bg-indigo-50 p-2.5">
                      <Icon className="h-5 w-5 text-indigo-600" />
                    </div>
                    <h3 className="text-base font-semibold text-foreground mb-2">{pillar.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{pillar.description}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Product modules showcase */}
        <section className="py-20 lg:py-28 bg-muted/20 border-y border-border">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-14">
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-4">
                One platform, complete coverage
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                From campaign performance to creative analysis to geographic signals — every data
                layer is connected and searchable.
              </p>
            </div>

            <div className="flex flex-col gap-16">
              {[
                {
                  title: "Overview dashboard",
                  description:
                    "See your top KPIs — revenue, ROAS, spend, purchases — across all connected platforms at a glance. Spot trends and get AI-generated insights before your morning standup.",
                  align: "left",
                  metrics: [
                    { label: "Revenue", value: "$84,320", up: true },
                    { label: "ROAS", value: "4.2x", up: true },
                    { label: "Spend", value: "$20,076", up: false },
                    { label: "Purchases", value: "1,204", up: true },
                  ],
                },
                {
                  title: "Creative intelligence",
                  description:
                    "Understand which visuals and formats drive performance. Compare creatives side by side, see performance metrics per asset, and identify winning patterns before scaling.",
                  align: "right",
                  metrics: [
                    { label: "Top creative CTR", value: "4.8%", up: true },
                    { label: "Hook rate", value: "61%", up: true },
                    { label: "ROAS", value: "5.1x", up: true },
                    { label: "CPR", value: "$4.20", up: false },
                  ],
                },
                {
                  title: "GEO intelligence",
                  description:
                    "Discover which regions are driving conversions, which are underperforming relative to spend, and where organic search intent is strongest for your product category.",
                  align: "left",
                  metrics: [
                    { label: "Top region ROAS", value: "6.1x", up: true },
                    { label: "Expansion signals", value: "7 regions", up: true },
                    { label: "Organic sessions", value: "12,400", up: true },
                    { label: "Avg CPA", value: "$18.40", up: false },
                  ],
                },
              ].map((module) => (
                <div
                  key={module.title}
                  className={`flex flex-col ${
                    module.align === "right" ? "lg:flex-row-reverse" : "lg:flex-row"
                  } items-start lg:items-center gap-8 lg:gap-16`}
                >
                  <div className="flex-1 max-w-md">
                    <h3 className="text-2xl font-bold text-foreground mb-3">{module.title}</h3>
                    <p className="text-base text-muted-foreground leading-relaxed">
                      {module.description}
                    </p>
                    <Link
                      href="/product"
                      className="inline-flex items-center mt-5 text-sm font-medium text-indigo-600 hover:text-indigo-700 transition-colors"
                    >
                      Learn more
                      <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                    </Link>
                  </div>

                  <div className="flex-1 w-full rounded-xl border border-border bg-card p-5 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <p className="text-sm font-medium text-foreground">{module.title}</p>
                      <div className="flex items-center gap-1.5">
                        <div className="h-2.5 w-16 rounded bg-muted" />
                        <div className="h-2.5 w-10 rounded bg-muted" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      {module.metrics.map((m) => (
                        <div key={m.label} className="rounded-lg border border-border bg-background p-3">
                          <p className="text-xs text-muted-foreground mb-1">{m.label}</p>
                          <p className="text-base font-semibold text-foreground">{m.value}</p>
                          <div className={`mt-1 h-1.5 w-8 rounded-full ${m.up ? "bg-green-400/60" : "bg-red-400/40"}`} />
                        </div>
                      ))}
                    </div>
                    <div className="rounded-lg bg-muted/50 p-3 flex flex-col gap-1.5">
                      {[80, 55, 70, 90].map((w, i) => (
                        <div key={i} className="h-2 rounded-full bg-indigo-200/60" style={{ width: `${w}%` }} />
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Decision intelligence section */}
        <section className="py-20 lg:py-28">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="lg:grid lg:grid-cols-2 lg:gap-16 items-center">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 mb-6">
                  <Zap className="h-3.5 w-3.5" />
                  Decision intelligence layer
                </div>
                <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-5">
                  Decision intelligence, not just reporting.
                </h2>
                <p className="text-base text-muted-foreground leading-relaxed mb-8">
                  Adsecute doesn't just show you numbers — it tells you what they mean.
                  Deterministic recommendation systems and optional AI commentary interpret patterns
                  across campaigns, creatives, and geographic data so the next step is explicit.
                </p>
                <ul className="flex flex-col gap-4">
                  {[
                    {
                      title: "Optimization recommendations",
                      desc: "Get specific, ranked suggestions for budget reallocation, audience expansion, and creative iteration.",
                    },
                    {
                      title: "Creative and copy analysis",
                      desc: "Understand which elements of your ads drive performance — hooks, formats, messaging angles.",
                    },
                    {
                      title: "GEO opportunity detection",
                      desc: "Identify geographic markets where organic intent is high but paid coverage is low.",
                    },
                    {
                      title: "Campaign insights",
                      desc: "Surface anomalies, budget inefficiencies, and performance trends before they become expensive problems.",
                    },
                  ].map((item) => (
                    <li key={item.title} className="flex items-start gap-3">
                      <CheckCircle2 className="h-4.5 w-4.5 text-indigo-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-foreground">{item.title}</p>
                        <p className="text-sm text-muted-foreground mt-0.5">{item.desc}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-12 lg:mt-0 rounded-xl border border-border bg-card p-6 shadow-sm">
                <p className="text-sm font-medium text-foreground mb-4">Recommendations</p>
                {[
                  {
                    priority: "High",
                    color: "bg-red-100 text-red-700",
                    title: "Scale top creative",
                    desc: "Campaign #4 creative has 5.1x ROAS on 3,200 impressions. Increase budget by 40%.",
                  },
                  {
                    priority: "Medium",
                    color: "bg-yellow-100 text-yellow-700",
                    title: "Expand to Pacific Northwest",
                    desc: "High organic search intent for your category with low paid competition. CPA estimate $14.",
                  },
                  {
                    priority: "Medium",
                    color: "bg-yellow-100 text-yellow-700",
                    title: "Pause underperforming ad set",
                    desc: "Ad set targeting 35-44M has $420 spend with 0.8x ROAS over 14 days.",
                  },
                  {
                    priority: "Low",
                    color: "bg-blue-100 text-blue-700",
                    title: "Test question-format copy",
                    desc: "Your top 3 ads use statement hooks. Question-format hooks show +22% CTR in your niche.",
                  },
                ].map((rec, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 p-3 rounded-lg border border-border bg-background mb-2.5 last:mb-0"
                  >
                    <span
                      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium shrink-0 mt-0.5 ${rec.color}`}
                    >
                      {rec.priority}
                    </span>
                    <div>
                      <p className="text-sm font-medium text-foreground">{rec.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{rec.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Use cases */}
        <section className="py-20 lg:py-28 bg-muted/20 border-y border-border">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-14">
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-4">
                Built for the people who run ads
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Whether you manage one store or forty clients, Adsecute gives you the signal you
                need to make confident decisions.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {USE_CASES.map((uc) => {
                const Icon = uc.icon;
                return (
                  <div key={uc.role} className="rounded-xl border border-border bg-card p-6">
                    <div className="mb-4 inline-flex items-center justify-center rounded-lg bg-muted p-2.5">
                      <Icon className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <h3 className="text-base font-semibold text-foreground mb-2">{uc.role}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{uc.description}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Pricing teaser */}
        <section className="py-20 lg:py-28">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-14">
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-4">
                Simple, transparent pricing
              </h2>
              <p className="text-lg text-muted-foreground max-w-xl mx-auto">
                Start free and upgrade as you grow. No hidden fees, no per-seat nonsense.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-10">
              {PRICING_PLANS.map((plan) => (
                <div
                  key={plan.name}
                  className={`relative rounded-xl border p-6 flex flex-col ${
                    plan.featured
                      ? "border-indigo-300 bg-indigo-50 shadow-sm"
                      : "border-border bg-card"
                  }`}
                >
                  {plan.featured && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <span className="inline-flex items-center rounded-full bg-indigo-600 px-3 py-0.5 text-xs font-medium text-white">
                        Most popular
                      </span>
                    </div>
                  )}
                  <p className="text-sm font-semibold text-foreground mb-1">{plan.name}</p>
                  <div className="mb-1 flex items-baseline gap-1">
                    <span className="text-2xl font-bold text-foreground">{plan.price}</span>
                    {plan.period && (
                      <span className="text-sm text-muted-foreground">{plan.period}</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mb-4">{plan.description}</p>
                  <ul className="flex flex-col gap-1.5 flex-1">
                    {plan.highlights.map((h) => (
                      <li key={h} className="flex items-center gap-2 text-xs text-muted-foreground">
                        <CheckCircle2 className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
                        {h}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="text-center">
              <Link
                href="/pricing"
                className="inline-flex items-center gap-2 text-sm font-medium text-indigo-600 hover:text-indigo-700 transition-colors"
              >
                View full pricing details
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="py-20 lg:py-28 bg-foreground">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-background mb-5">
              Start understanding your ad performance today.
            </h2>
            <p className="text-base text-background/70 max-w-xl mx-auto mb-8">
              Connect your Shopify store and ad accounts in minutes. The Starter plan is free —
              no credit card required.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/login"
                className="inline-flex items-center justify-center rounded-lg bg-background px-6 py-3 text-sm font-medium text-foreground hover:bg-background/90 transition-colors"
              >
                Get started free
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
              <a
                href="/api/auth/demo-login"
                className="inline-flex items-center justify-center rounded-lg border border-background/30 px-6 py-3 text-sm font-medium text-background hover:bg-background/10 transition-colors"
              >
                Explore the demo
              </a>
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}

// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run zero-base:contracts:generate
// Verify with:     npm run zero-base:contracts:check
//
// Source: docs/zero-base-design/v3 (archive
// 0695ae452469ba3efe2615efe3ffd30fcdb88f5847db53d569042fb864c09b9d)
// Active-manifest fingerprint: f27bf51b31ddffe20b5c6404f5b7c1758ba5087342cd84941bf6c2d937befe4a
// Rule version: 3.1.0
// Vendored input digests:
//   export/sitemap.json              558f626b5448eb2172042789bae6d4378eca86366eed8e0789c045e99f877c2a
//   export/interaction-manifest.json 9673ac631645fadc8ef428d8f84249b393865107f6ede7d57fd03ab9cf208596
//   export/report-catalog.json       5b823c131db214ec7bbe6746f47c1692744b6a5bc2910c7981ccc251c5c51169
//   export/instrumentation-ledger.json b07421a30fec16ef0273795616a93a11a6ebe852968a41e974c24a851c438956

export const DESIGN_FINGERPRINT = "f27bf51b31ddffe20b5c6404f5b7c1758ba5087342cd84941bf6c2d937befe4a" as const;
export const DESIGN_RULE_VERSION = "3.1.0" as const;

export type LeafId =
  | "L-PUB-ROOT"
  | "L-PUB-ABOUT"
  | "L-PUB-PRODUCT"
  | "L-PUB-PRICING"
  | "L-PUB-CONTACT"
  | "L-PUB-PRIVACY"
  | "L-PUB-TERMS"
  | "L-PUB-SECURITY"
  | "L-PUB-AITRANS"
  | "L-AUTH-LOGIN"
  | "L-AUTH-SIGNUP"
  | "L-AUTH-FORGOT"
  | "L-AUTH-RESET"
  | "L-AUTH-DEMO"
  | "L-AUTH-INVITE"
  | "L-AUTH-SELBIZ"
  | "L-AUTH-NEWBIZ"
  | "L-ME-ACCOUNT"
  | "L-ME-LANG"
  | "L-AUTH-SHOPIFY"
  | "L-A-DESK"
  | "L-A-CLIENTS"
  | "L-A-WITHHELD"
  | "L-C-HOME"
  | "L-C-META-DEC"
  | "L-C-META-INTEL"
  | "L-C-META-LAUNCH"
  | "L-C-META-AUTO"
  | "L-C-META-HIST"
  | "L-C-CR-PERF"
  | "L-C-CR-DETAIL"
  | "L-C-CR-BRIEFS"
  | "L-C-CR-INBOX"
  | "L-C-CR-COPIES"
  | "L-C-CR-LP"
  | "L-C-CR-SHARES"
  | "L-C-G-OVER"
  | "L-C-G-ADV"
  | "L-C-G-SEARCH"
  | "L-C-G-PROD"
  | "L-C-G-ASSETS"
  | "L-C-G-PLAN"
  | "L-C-AN-GA"
  | "L-C-AN-LP"
  | "L-C-AN-SEO"
  | "L-C-AN-GEO"
  | "L-C-REP"
  | "L-C-REP-NEW"
  | "L-C-REP-VIEW"
  | "L-C-REP-EDIT"
  | "L-C-REP-PRINT"
  | "L-C-M-INT"
  | "L-C-M-CB"
  | "L-C-M-TEAM"
  | "L-C-M-BIZ"
  | "L-C-M-PLAN"
  | "L-OPS-OVER"
  | "L-OPS-ACT"
  | "L-OPS-AUTH"
  | "L-OPS-BIZ"
  | "L-OPS-BIZ-D"
  | "L-OPS-DISC"
  | "L-OPS-DISC-N"
  | "L-OPS-DISC-D"
  | "L-OPS-INT"
  | "L-OPS-REL"
  | "L-OPS-REV"
  | "L-OPS-SUBS"
  | "L-OPS-SYNC"
  | "L-OPS-CAP"
  | "L-OPS-USERS"
  | "L-OPS-USER-D"
  | "L-SH-CREATIVE"
  | "L-SH-REPORT";

export type CanonicalPathPattern =
  | "/"
  | "/about"
  | "/product"
  | "/pricing"
  | "/contact"
  | "/privacy"
  | "/terms"
  | "/security"
  | "/ai-transparency"
  | "/login"
  | "/signup"
  | "/forgot-password"
  | "/reset-password"
  | "/demo"
  | "/invite/[token]"
  | "/select-business"
  | "/businesses/new"
  | "/me/account-security"
  | "/me/language"
  | "/shopify/connect"
  | "/a/desk"
  | "/a/desk/clients"
  | "/a/desk/withheld"
  | "/c/[businessId]/home"
  | "/c/[businessId]/meta/decisions"
  | "/c/[businessId]/meta/intelligence"
  | "/c/[businessId]/meta/launchpad"
  | "/c/[businessId]/meta/automation"
  | "/c/[businessId]/meta/history"
  | "/c/[businessId]/creative/performance"
  | "/c/[businessId]/creative/[creativeId]"
  | "/c/[businessId]/creative/briefs"
  | "/c/[businessId]/creative/inbox"
  | "/c/[businessId]/creative/copies"
  | "/c/[businessId]/creative/landing-pages"
  | "/c/[businessId]/creative/shares"
  | "/c/[businessId]/google/overview"
  | "/c/[businessId]/google/advisor"
  | "/c/[businessId]/google/search"
  | "/c/[businessId]/google/products"
  | "/c/[businessId]/google/assets-audiences"
  | "/c/[businessId]/google/plan"
  | "/c/[businessId]/analytics/ga4-shopify"
  | "/c/[businessId]/analytics/landing-pages"
  | "/c/[businessId]/analytics/seo"
  | "/c/[businessId]/analytics/geo"
  | "/c/[businessId]/reports"
  | "/c/[businessId]/reports/new"
  | "/c/[businessId]/reports/[reportId]"
  | "/c/[businessId]/reports/[reportId]/edit"
  | "/c/[businessId]/reports/[reportId]/print"
  | "/c/[businessId]/manage/integrations"
  | "/c/[businessId]/manage/integrations/callback/[provider]"
  | "/c/[businessId]/manage/team"
  | "/c/[businessId]/manage/business"
  | "/c/[businessId]/manage/plan"
  | "/ops"
  | "/ops/activity"
  | "/ops/auth-health"
  | "/ops/businesses"
  | "/ops/businesses/[businessId]"
  | "/ops/discounts"
  | "/ops/discounts/new"
  | "/ops/discounts/[codeId]"
  | "/ops/integrations"
  | "/ops/release-authority"
  | "/ops/revenue-risk"
  | "/ops/subscriptions"
  | "/ops/sync-health"
  | "/ops/system-capacity"
  | "/ops/users"
  | "/ops/users/[userId]"
  | "/share/creative/[token]"
  | "/share/report/[token]";

export type SurfaceToken =
  | "pub_home"
  | "pub_about"
  | "pub_product"
  | "pub_pricing"
  | "pub_contact"
  | "pub_privacy"
  | "pub_terms"
  | "pub_security"
  | "pub_ai_transparency"
  | "auth_login"
  | "auth_signup"
  | "auth_forgot_password"
  | "auth_reset_password"
  | "auth_demo"
  | "auth_invite"
  | "auth_select_business"
  | "auth_business_new"
  | "me_account_security"
  | "me_language"
  | "auth_shopify_connect"
  | "agency_desk_today"
  | "agency_desk_clients"
  | "agency_desk_withheld"
  | "client_home"
  | "meta_decisions"
  | "meta_intelligence"
  | "meta_launchpad"
  | "meta_automation"
  | "meta_history"
  | "creative_performance"
  | "creative_detail"
  | "creative_briefs"
  | "creative_inbox"
  | "creative_copies"
  | "creative_landing_pages"
  | "creative_shares"
  | "google_overview"
  | "google_advisor"
  | "google_search"
  | "google_products"
  | "google_assets_audiences"
  | "google_plan"
  | "analytics_ga4_shopify"
  | "analytics_landing_pages"
  | "analytics_seo"
  | "analytics_geo"
  | "reports_library"
  | "reports_new"
  | "reports_view"
  | "reports_edit"
  | "reports_print"
  | "manage_integrations"
  | "manage_integrations_callback"
  | "manage_team"
  | "manage_business"
  | "manage_plan"
  | "ops_overview"
  | "ops_activity"
  | "ops_auth_health"
  | "ops_businesses"
  | "ops_business_detail"
  | "ops_discounts"
  | "ops_discount_new"
  | "ops_discount_detail"
  | "ops_integrations"
  | "ops_release_authority"
  | "ops_revenue_risk"
  | "ops_subscriptions"
  | "ops_sync_health"
  | "ops_system_capacity"
  | "ops_users"
  | "ops_user_detail"
  | "share_creative"
  | "share_report";

export type InteractionContractKey =
  | "live:AUTH-01"
  | "live:AUTH-02 email"
  | "live:AUTH-02 password"
  | "live:AUTH-02 submit"
  | "live:AUTH-03 google"
  | "live:AUTH-04 facebook"
  | "live:AUTH-05 forgot"
  | "live:AUTH-06 demo"
  | "live:AUTH-07 user-menu"
  | "live:AUTH-10 scope-switch"
  | "live:AUTH-10 business-switcher"
  | "live:AUTH-11 name"
  | "live:AUTH-11 email"
  | "live:AUTH-12 current"
  | "live:AUTH-12 new"
  | "live:AUTH-12 save"
  | "live:AUTH-13 revoke"
  | "live:cancel"
  | "live:close"
  | "live:done"
  | "live:tab"
  | "live:lane"
  | "live:nav"
  | "live:nav-drawer"
  | "live:nav-drawer close"
  | "live:chart-table-toggle"
  | "live:SCOPE-03 account-picker"
  | "live:SCOPE-03 assign"
  | "live:SCOPE-05"
  | "live:SCOPE-06"
  | "live:SCOPE-10 window-picker"
  | "live:SCOPE-11 search"
  | "live:SCOPE-11 client-search"
  | "live:SCOPE-12 result"
  | "live:AGENCY-02 withheld-explainer"
  | "live:AGENCY-04 open-client"
  | "live:AGENCY-04 load-more"
  | "live:HEALTH-01"
  | "live:INTEGRATION-02"
  | "live:INTEGRATION-03"
  | "live:INTEGRATION-03 connect"
  | "live:INTEGRATION-07"
  | "live:INTEGRATION-07 assign"
  | "live:INTEGRATION-07 save"
  | "live:SHOPIFY-01"
  | "live:ECON-01 edit"
  | "live:ECON-03 edit"
  | "live:ECON-04 divergence-link"
  | "live:I18N-02 lang"
  | "live:PUBLIC-03"
  | "live:PUBLIC-05"
  | "live:META-DEC-01 lane"
  | "live:META-DEC-02 level"
  | "live:META-DEC-05 open-inspector"
  | "live:META-DEC-05 load-more"
  | "live:META-DEC-13 open"
  | "live:META-DEC-17 search"
  | "live:INV-18 share-view"
  | "gated:META-WF-02..08 menu"
  | "live:META-WF-11 keep"
  | "live:META-WF-11 reapply"
  | "gated:META-WRITE-01"
  | "gated:META-WRITE-01 open-manual"
  | "live:META-WRITE-06 rerun"
  | "gated:META-WRITE-02 continue"
  | "gated:META-WRITE-02 submit"
  | "live:META-WRITE-08 copy-receipt"
  | "gated:META-INTEL-09 run-snapshot"
  | "live:META-INTEL-07 respond"
  | "live:META-HIST-05 filter"
  | "live:META-HIST-05 search"
  | "live:META-HIST-05 cursor"
  | "live:META-HIST-06 replay"
  | "gated:AUTO-01A engage"
  | "gated:AUTO-02 release"
  | "gated:AUTO-03 mode"
  | "live:CREATIVE-02 open"
  | "live:CREATIVE-02 back"
  | "live:CREATIVE-02 carousel-dot"
  | "live:CREATIVE-07 brief"
  | "live:CREATIVE-07 status"
  | "live:CREATIVE-10 share"
  | "live:CREATIVE-10 expiry"
  | "live:CREATIVE-11 tier"
  | "live:CREATIVE-11 ack"
  | "live:CREATIVE-10 mint"
  | "disabled:CREATIVE-10 mint"
  | "live:CREATIVE-10 revoke"
  | "live:CREATIVE-10 rotate"
  | "live:CREATIVE-12 preset"
  | "live:CREATIVE-12 sort"
  | "live:CREATIVE-13 filter"
  | "live:LAUNCH-01 fix"
  | "live:LAUNCH-02 fix"
  | "live:LAUNCH-03 duplicate"
  | "gated:LAUNCH-03 delete"
  | "live:LAUNCH-05 validate"
  | "disabled:LAUNCH-06 launch"
  | "disabled:LAUNCH-07 add"
  | "live:GOOGLE-13 bucket"
  | "live:GOOGLE-16 open-card"
  | "live:GOOGLE-26 dismiss"
  | "live:GOOGLE-28 mark-applied"
  | "live:GOOGLE-30 deeplink"
  | "live:GOOGLE-32 portfolio"
  | "live:GOOGLE-ESC-01 copy"
  | "live:GOOGLE-ESC-01 copy-all"
  | "live:GOOGLE-ESC-01 csv"
  | "live:GOOGLE-ESC-01 csv-all"
  | "gated:SEO-04 run"
  | "live:REPORT-05 source-toggle"
  | "disabled:REPORT-06 source-unavailable"
  | "live:REPORT-13 new"
  | "live:REPORT-08 open"
  | "live:REPORT-08 retry"
  | "live:REPORT-02 edit"
  | "live:REPORT-01 duplicate"
  | "gated:REPORT-01 delete"
  | "live:REPORT-03 keyboard-mode"
  | "live:REPORT-03 widget-select"
  | "live:REPORT-03 nudge-move"
  | "live:REPORT-03 nudge-resize"
  | "live:REPORT-03 undo"
  | "live:REPORT-03 exit"
  | "live:REPORT-04 csv"
  | "live:REPORT-07 breakdown"
  | "live:MOBILE-01"
  | "live:MOBILE-02 scope-sheet"
  | "gated:SCOPE-01 delete"
  | "gated:TEAM-02 role"
  | "gated:TEAM-03"
  | "gated:TEAM-04"
  | "gated:TEAM-04 invite"
  | "gated:TEAM-05 approve"
  | "gated:TEAM-05 deny"
  | "gated:INTEGRATION-09"
  | "gated:ADMIN-12 repair"
  | "disabled:INV-24 reviewer-block"
  | "live:SEO-01 load-more"
  | "live:REPORT-01 load-more"
  | "live:media-play"
  | "live:media-retry";

export type ReportSourceId =
  | "overview_summary"
  | "overview_trend"
  | "channel_attribution"
  | "meta_campaigns"
  | "google_campaigns"
  | "shopify_data"
  | "ga4_data"
  | "search_console_data"
  | "klaviyo_data";

export type LeafAvailability =
  | "live"
  | "new-surface";

export type LegacyMappingMode =
  | "alias"
  | "merged"
  | "redirect"
  | "split";

export type LeafContext =
  | "Agency"
  | "Auth"
  | "Client"
  | "Ops"
  | "Public"
  | "Share";

export interface GeneratedLeaf {
  readonly leaf: LeafId;
  readonly label: string;
  readonly url: CanonicalPathPattern;
  readonly ctx: LeafContext;
  readonly role: string;
  readonly availability: LeafAvailability;
  readonly surface: SurfaceToken;
  readonly event: string;
  readonly legacy: ReadonlyArray<{ readonly route: string; readonly mode: LegacyMappingMode }>;
}

export const GENERATED_LEAVES: readonly GeneratedLeaf[] = [
  {
    leaf: "L-PUB-ROOT",
    label: "Marketing home",
    url: "/",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "pub_home",
    event: "screen_view",
    legacy: [{ route: "/", mode: "alias" }],
  },
  {
    leaf: "L-PUB-ABOUT",
    label: "About",
    url: "/about",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "pub_about",
    event: "screen_view",
    legacy: [{ route: "/about", mode: "alias" }],
  },
  {
    leaf: "L-PUB-PRODUCT",
    label: "Product",
    url: "/product",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "pub_product",
    event: "screen_view",
    legacy: [{ route: "/product", mode: "alias" }],
  },
  {
    leaf: "L-PUB-PRICING",
    label: "Pricing",
    url: "/pricing",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "pub_pricing",
    event: "screen_view",
    legacy: [{ route: "/pricing", mode: "alias" }],
  },
  {
    leaf: "L-PUB-CONTACT",
    label: "Contact",
    url: "/contact",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "pub_contact",
    event: "screen_view",
    legacy: [{ route: "/contact", mode: "alias" }],
  },
  {
    leaf: "L-PUB-PRIVACY",
    label: "Privacy",
    url: "/privacy",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "pub_privacy",
    event: "screen_view",
    legacy: [{ route: "/privacy", mode: "alias" }],
  },
  {
    leaf: "L-PUB-TERMS",
    label: "Terms",
    url: "/terms",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "pub_terms",
    event: "screen_view",
    legacy: [{ route: "/terms", mode: "alias" }],
  },
  {
    leaf: "L-PUB-SECURITY",
    label: "Security",
    url: "/security",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "pub_security",
    event: "screen_view",
    legacy: [{ route: "/security", mode: "alias" }],
  },
  {
    leaf: "L-PUB-AITRANS",
    label: "AI transparency",
    url: "/ai-transparency",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "pub_ai_transparency",
    event: "screen_view",
    legacy: [{ route: "/ai-transparency", mode: "alias" }],
  },
  {
    leaf: "L-AUTH-LOGIN",
    label: "Login",
    url: "/login",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "auth_login",
    event: "screen_view",
    legacy: [{ route: "/login", mode: "alias" }],
  },
  {
    leaf: "L-AUTH-SIGNUP",
    label: "Signup",
    url: "/signup",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "auth_signup",
    event: "screen_view",
    legacy: [{ route: "/signup", mode: "alias" }],
  },
  {
    leaf: "L-AUTH-FORGOT",
    label: "Password reset request",
    url: "/forgot-password",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "auth_forgot_password",
    event: "screen_view",
    legacy: [{ route: "/forgot-password", mode: "alias" }],
  },
  {
    leaf: "L-AUTH-RESET",
    label: "Password reset confirm",
    url: "/reset-password",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "auth_reset_password",
    event: "screen_view",
    legacy: [{ route: "/reset-password", mode: "alias" }],
  },
  {
    leaf: "L-AUTH-DEMO",
    label: "Demo entry",
    url: "/demo",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "auth_demo",
    event: "screen_view",
    legacy: [{ route: "/demo", mode: "alias" }],
  },
  {
    leaf: "L-AUTH-INVITE",
    label: "Invite acceptance",
    url: "/invite/[token]",
    ctx: "Public",
    role: "Public",
    availability: "live",
    surface: "auth_invite",
    event: "screen_view",
    legacy: [{ route: "/invite/[token]", mode: "alias" }],
  },
  {
    leaf: "L-AUTH-SELBIZ",
    label: "Business selection",
    url: "/select-business",
    ctx: "Auth",
    role: "Any authenticated",
    availability: "live",
    surface: "auth_select_business",
    event: "screen_view",
    legacy: [{ route: "/select-business", mode: "alias" }],
  },
  {
    leaf: "L-AUTH-NEWBIZ",
    label: "First/new business creation",
    url: "/businesses/new",
    ctx: "Auth",
    role: "Any authenticated",
    availability: "live",
    surface: "auth_business_new",
    event: "screen_view",
    legacy: [{ route: "/businesses/new", mode: "alias" }],
  },
  {
    leaf: "L-ME-ACCOUNT",
    label: "Account & Security",
    url: "/me/account-security",
    ctx: "Auth",
    role: "Any authenticated",
    availability: "new-surface",
    surface: "me_account_security",
    event: "screen_view",
    legacy: [{ route: "/settings", mode: "split" }],
  },
  {
    leaf: "L-ME-LANG",
    label: "Language",
    url: "/me/language",
    ctx: "Auth",
    role: "Any authenticated",
    availability: "live",
    surface: "me_language",
    event: "screen_view",
    legacy: [{ route: "/select-language", mode: "redirect" }],
  },
  {
    leaf: "L-AUTH-SHOPIFY",
    label: "Shopify embedded install",
    url: "/shopify/connect",
    ctx: "Auth",
    role: "Business member",
    availability: "live",
    surface: "auth_shopify_connect",
    event: "screen_view",
    legacy: [{ route: "/shopify/connect", mode: "alias" }],
  },
  {
    leaf: "L-A-DESK",
    label: "Agency Desk — Today",
    url: "/a/desk",
    ctx: "Agency",
    role: "Agency member",
    availability: "new-surface",
    surface: "agency_desk_today",
    event: "screen_view",
    legacy: [],
  },
  {
    leaf: "L-A-CLIENTS",
    label: "Agency Desk — Clients",
    url: "/a/desk/clients",
    ctx: "Agency",
    role: "Agency member",
    availability: "new-surface",
    surface: "agency_desk_clients",
    event: "screen_view",
    legacy: [],
  },
  {
    leaf: "L-A-WITHHELD",
    label: "Agency Desk — withheld explainer",
    url: "/a/desk/withheld",
    ctx: "Agency",
    role: "Agency member",
    availability: "new-surface",
    surface: "agency_desk_withheld",
    event: "screen_view",
    legacy: [],
  },
  {
    leaf: "L-C-HOME",
    label: "Client Home",
    url: "/c/[businessId]/home",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "client_home",
    event: "screen_view",
    legacy: [{ route: "/overview", mode: "redirect" }],
  },
  {
    leaf: "L-C-META-DEC",
    label: "Meta — Decisions",
    url: "/c/[businessId]/meta/decisions",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "meta_decisions",
    event: "screen_view",
    legacy: [{ route: "/platforms/meta", mode: "redirect" }],
  },
  {
    leaf: "L-C-META-INTEL",
    label: "Meta — Account Intelligence",
    url: "/c/[businessId]/meta/intelligence",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "meta_intelligence",
    event: "screen_view",
    legacy: [{ route: "/platforms/meta/audiences", mode: "merged" }],
  },
  {
    leaf: "L-C-META-LAUNCH",
    label: "Meta — Launchpad",
    url: "/c/[businessId]/meta/launchpad",
    ctx: "Client",
    role: "Business member (collab+ to edit)",
    availability: "live",
    surface: "meta_launchpad",
    event: "screen_view",
    legacy: [{ route: "/platforms/meta/launchpad", mode: "redirect" }],
  },
  {
    leaf: "L-C-META-AUTO",
    label: "Meta — Automation & Meta Stop",
    url: "/c/[businessId]/meta/automation",
    ctx: "Client",
    role: "Business member (admin to engage)",
    availability: "live",
    surface: "meta_automation",
    event: "screen_view",
    legacy: [{ route: "/platforms/meta/automation", mode: "redirect" }],
  },
  {
    leaf: "L-C-META-HIST",
    label: "Meta — History",
    url: "/c/[businessId]/meta/history",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "meta_history",
    event: "screen_view",
    legacy: [{ route: "/platforms/meta/history", mode: "redirect" }],
  },
  {
    leaf: "L-C-CR-PERF",
    label: "Creative — Performance",
    url: "/c/[businessId]/creative/performance",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "creative_performance",
    event: "screen_view",
    legacy: [{ route: "/platforms/meta/creatives", mode: "redirect" }],
  },
  {
    leaf: "L-C-CR-DETAIL",
    label: "Creative — Detail & History",
    url: "/c/[businessId]/creative/[creativeId]",
    ctx: "Client",
    role: "Business member",
    availability: "new-surface",
    surface: "creative_detail",
    event: "screen_view",
    legacy: [],
  },
  {
    leaf: "L-C-CR-BRIEFS",
    label: "Creative — Briefs",
    url: "/c/[businessId]/creative/briefs",
    ctx: "Client",
    role: "Business member (collab+ to create)",
    availability: "new-surface",
    surface: "creative_briefs",
    event: "screen_view",
    legacy: [],
  },
  {
    leaf: "L-C-CR-INBOX",
    label: "Creative — Inbox",
    url: "/c/[businessId]/creative/inbox",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "creative_inbox",
    event: "screen_view",
    legacy: [{ route: "/platforms/meta/creative-inbox", mode: "redirect" }],
  },
  {
    leaf: "L-C-CR-COPIES",
    label: "Creative — Copies",
    url: "/c/[businessId]/creative/copies",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "creative_copies",
    event: "screen_view",
    legacy: [{ route: "/platforms/meta/copies", mode: "redirect" }],
  },
  {
    leaf: "L-C-CR-LP",
    label: "Creative — Landing Pages",
    url: "/c/[businessId]/creative/landing-pages",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "creative_landing_pages",
    event: "screen_view",
    legacy: [{ route: "/platforms/meta/landing-pages", mode: "redirect" }],
  },
  {
    leaf: "L-C-CR-SHARES",
    label: "Creative — Shares",
    url: "/c/[businessId]/creative/shares",
    ctx: "Client",
    role: "Business member (collab+ to mint)",
    availability: "new-surface",
    surface: "creative_shares",
    event: "screen_view",
    legacy: [],
  },
  {
    leaf: "L-C-G-OVER",
    label: "Google — Overview",
    url: "/c/[businessId]/google/overview",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "google_overview",
    event: "screen_view",
    legacy: [{ route: "/platforms/google", mode: "redirect" }, { route: "/platforms/google/pulse", mode: "merged" }],
  },
  {
    leaf: "L-C-G-ADV",
    label: "Google — Advisor",
    url: "/c/[businessId]/google/advisor",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "google_advisor",
    event: "screen_view",
    legacy: [{ route: "/platforms/google/ads", mode: "merged" }],
  },
  {
    leaf: "L-C-G-SEARCH",
    label: "Google — Search",
    url: "/c/[businessId]/google/search",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "google_search",
    event: "screen_view",
    legacy: [{ route: "/platforms/google/keywords", mode: "redirect" }],
  },
  {
    leaf: "L-C-G-PROD",
    label: "Google — Products",
    url: "/c/[businessId]/google/products",
    ctx: "Client",
    role: "Business member",
    availability: "new-surface",
    surface: "google_products",
    event: "screen_view",
    legacy: [],
  },
  {
    leaf: "L-C-G-ASSETS",
    label: "Google — Assets & Audiences",
    url: "/c/[businessId]/google/assets-audiences",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "google_assets_audiences",
    event: "screen_view",
    legacy: [{ route: "/platforms/google/audiences", mode: "redirect" }],
  },
  {
    leaf: "L-C-G-PLAN",
    label: "Google — Manual Plan & Activity",
    url: "/c/[businessId]/google/plan",
    ctx: "Client",
    role: "Business member (collab+ to edit)",
    availability: "new-surface",
    surface: "google_plan",
    event: "screen_view",
    legacy: [],
  },
  {
    leaf: "L-C-AN-GA",
    label: "Analytics — GA4 & Shopify",
    url: "/c/[businessId]/analytics/ga4-shopify",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "analytics_ga4_shopify",
    event: "screen_view",
    legacy: [{ route: "/insights", mode: "merged" }, { route: "/insights/analytics", mode: "redirect" }],
  },
  {
    leaf: "L-C-AN-LP",
    label: "Analytics — Landing Pages & Products",
    url: "/c/[businessId]/analytics/landing-pages",
    ctx: "Client",
    role: "Business member",
    availability: "new-surface",
    surface: "analytics_landing_pages",
    event: "screen_view",
    legacy: [],
  },
  {
    leaf: "L-C-AN-SEO",
    label: "Analytics — SEO & Search Console",
    url: "/c/[businessId]/analytics/seo",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "analytics_seo",
    event: "screen_view",
    legacy: [{ route: "/insights/seo", mode: "redirect" }],
  },
  {
    leaf: "L-C-AN-GEO",
    label: "Analytics — GEO / AI Visibility",
    url: "/c/[businessId]/analytics/geo",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "analytics_geo",
    event: "screen_view",
    legacy: [{ route: "/insights/ai-visibility", mode: "redirect" }],
  },
  {
    leaf: "L-C-REP",
    label: "Reports — library",
    url: "/c/[businessId]/reports",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "reports_library",
    event: "screen_view",
    legacy: [{ route: "/reports", mode: "redirect" }],
  },
  {
    leaf: "L-C-REP-NEW",
    label: "Reports — new from template",
    url: "/c/[businessId]/reports/new",
    ctx: "Client",
    role: "Business member (collab+)",
    availability: "live",
    surface: "reports_new",
    event: "screen_view",
    legacy: [{ route: "/reports/new", mode: "redirect" }],
  },
  {
    leaf: "L-C-REP-VIEW",
    label: "Reports — render",
    url: "/c/[businessId]/reports/[reportId]",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "reports_view",
    event: "screen_view",
    legacy: [{ route: "/reports/[reportId]", mode: "redirect" }],
  },
  {
    leaf: "L-C-REP-EDIT",
    label: "Reports — builder",
    url: "/c/[businessId]/reports/[reportId]/edit",
    ctx: "Client",
    role: "Business member (collab+)",
    availability: "live",
    surface: "reports_edit",
    event: "screen_view",
    legacy: [{ route: "/reports/[reportId]/edit", mode: "redirect" }],
  },
  {
    leaf: "L-C-REP-PRINT",
    label: "Reports — print/PDF",
    url: "/c/[businessId]/reports/[reportId]/print",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "reports_print",
    event: "screen_view",
    legacy: [{ route: "/reports/[reportId]/print", mode: "redirect" }],
  },
  {
    leaf: "L-C-M-INT",
    label: "Manage — Integrations & Data",
    url: "/c/[businessId]/manage/integrations",
    ctx: "Client",
    role: "Business member (admin to disconnect)",
    availability: "live",
    surface: "manage_integrations",
    event: "screen_view",
    legacy: [{ route: "/integrations", mode: "redirect" }],
  },
  {
    leaf: "L-C-M-CB",
    label: "Manage — OAuth callback",
    url: "/c/[businessId]/manage/integrations/callback/[provider]",
    ctx: "Client",
    role: "Business member",
    availability: "live",
    surface: "manage_integrations_callback",
    event: "screen_view",
    legacy: [{ route: "/integrations/callback/[provider]", mode: "redirect" }],
  },
  {
    leaf: "L-C-M-TEAM",
    label: "Manage — Team & Access",
    url: "/c/[businessId]/manage/team",
    ctx: "Client",
    role: "Business admin (members read)",
    availability: "live",
    surface: "manage_team",
    event: "screen_view",
    legacy: [{ route: "/team", mode: "redirect" }],
  },
  {
    leaf: "L-C-M-BIZ",
    label: "Manage — Business Settings",
    url: "/c/[businessId]/manage/business",
    ctx: "Client",
    role: "Business admin",
    availability: "live",
    surface: "manage_business",
    event: "screen_view",
    legacy: [{ route: "/settings", mode: "split" }, { route: "/commercial-truth", mode: "redirect" }],
  },
  {
    leaf: "L-C-M-PLAN",
    label: "Manage — Plan & Billing",
    url: "/c/[businessId]/manage/plan",
    ctx: "Client",
    role: "Business admin",
    availability: "new-surface",
    surface: "manage_plan",
    event: "screen_view",
    legacy: [],
  },
  {
    leaf: "L-OPS-OVER",
    label: "Ops — Overview",
    url: "/ops",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_overview",
    event: "screen_view",
    legacy: [{ route: "/admin", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-ACT",
    label: "Ops — Activity",
    url: "/ops/activity",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_activity",
    event: "screen_view",
    legacy: [{ route: "/admin/activity", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-AUTH",
    label: "Ops — Auth health",
    url: "/ops/auth-health",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_auth_health",
    event: "screen_view",
    legacy: [{ route: "/admin/auth-health", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-BIZ",
    label: "Ops — Businesses",
    url: "/ops/businesses",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_businesses",
    event: "screen_view",
    legacy: [{ route: "/admin/businesses", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-BIZ-D",
    label: "Ops — Business detail",
    url: "/ops/businesses/[businessId]",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_business_detail",
    event: "screen_view",
    legacy: [{ route: "/admin/businesses/[businessId]", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-DISC",
    label: "Ops — Discounts",
    url: "/ops/discounts",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_discounts",
    event: "screen_view",
    legacy: [{ route: "/admin/discounts", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-DISC-N",
    label: "Ops — New discount",
    url: "/ops/discounts/new",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_discount_new",
    event: "screen_view",
    legacy: [{ route: "/admin/discounts/new", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-DISC-D",
    label: "Ops — Discount detail",
    url: "/ops/discounts/[codeId]",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_discount_detail",
    event: "screen_view",
    legacy: [{ route: "/admin/discounts/[codeId]", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-INT",
    label: "Ops — Integration health",
    url: "/ops/integrations",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_integrations",
    event: "screen_view",
    legacy: [{ route: "/admin/integrations", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-REL",
    label: "Ops — Release authority",
    url: "/ops/release-authority",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_release_authority",
    event: "screen_view",
    legacy: [{ route: "/admin/release-authority", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-REV",
    label: "Ops — Revenue risk",
    url: "/ops/revenue-risk",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_revenue_risk",
    event: "screen_view",
    legacy: [{ route: "/admin/revenue-risk", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-SUBS",
    label: "Ops — Subscriptions",
    url: "/ops/subscriptions",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_subscriptions",
    event: "screen_view",
    legacy: [{ route: "/admin/subscriptions", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-SYNC",
    label: "Ops — Sync health",
    url: "/ops/sync-health",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_sync_health",
    event: "screen_view",
    legacy: [{ route: "/admin/sync-health", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-CAP",
    label: "Ops — System capacity",
    url: "/ops/system-capacity",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_system_capacity",
    event: "screen_view",
    legacy: [{ route: "/admin/system-capacity", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-USERS",
    label: "Ops — Users",
    url: "/ops/users",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_users",
    event: "screen_view",
    legacy: [{ route: "/admin/users", mode: "redirect" }],
  },
  {
    leaf: "L-OPS-USER-D",
    label: "Ops — User detail",
    url: "/ops/users/[userId]",
    ctx: "Ops",
    role: "Platform admin",
    availability: "live",
    surface: "ops_user_detail",
    event: "screen_view",
    legacy: [{ route: "/admin/users/[userId]", mode: "redirect" }],
  },
  {
    leaf: "L-SH-CREATIVE",
    label: "Public creative share",
    url: "/share/creative/[token]",
    ctx: "Share",
    role: "Unauthenticated token recipient",
    availability: "live",
    surface: "share_creative",
    event: "screen_view",
    legacy: [{ route: "/share/creative/[token]", mode: "alias" }],
  },
  {
    leaf: "L-SH-REPORT",
    label: "Public report share",
    url: "/share/report/[token]",
    ctx: "Share",
    role: "Unauthenticated token recipient",
    availability: "live",
    surface: "share_report",
    event: "screen_view",
    legacy: [{ route: "/share/report/[token]", mode: "alias" }],
  },
] as const;

export const GENERATED_CONTRACT_KEYS: readonly InteractionContractKey[] = [
  "live:AUTH-01",
  "live:AUTH-02 email",
  "live:AUTH-02 password",
  "live:AUTH-02 submit",
  "live:AUTH-03 google",
  "live:AUTH-04 facebook",
  "live:AUTH-05 forgot",
  "live:AUTH-06 demo",
  "live:AUTH-07 user-menu",
  "live:AUTH-10 scope-switch",
  "live:AUTH-10 business-switcher",
  "live:AUTH-11 name",
  "live:AUTH-11 email",
  "live:AUTH-12 current",
  "live:AUTH-12 new",
  "live:AUTH-12 save",
  "live:AUTH-13 revoke",
  "live:cancel",
  "live:close",
  "live:done",
  "live:tab",
  "live:lane",
  "live:nav",
  "live:nav-drawer",
  "live:nav-drawer close",
  "live:chart-table-toggle",
  "live:SCOPE-03 account-picker",
  "live:SCOPE-03 assign",
  "live:SCOPE-05",
  "live:SCOPE-06",
  "live:SCOPE-10 window-picker",
  "live:SCOPE-11 search",
  "live:SCOPE-11 client-search",
  "live:SCOPE-12 result",
  "live:AGENCY-02 withheld-explainer",
  "live:AGENCY-04 open-client",
  "live:AGENCY-04 load-more",
  "live:HEALTH-01",
  "live:INTEGRATION-02",
  "live:INTEGRATION-03",
  "live:INTEGRATION-03 connect",
  "live:INTEGRATION-07",
  "live:INTEGRATION-07 assign",
  "live:INTEGRATION-07 save",
  "live:SHOPIFY-01",
  "live:ECON-01 edit",
  "live:ECON-03 edit",
  "live:ECON-04 divergence-link",
  "live:I18N-02 lang",
  "live:PUBLIC-03",
  "live:PUBLIC-05",
  "live:META-DEC-01 lane",
  "live:META-DEC-02 level",
  "live:META-DEC-05 open-inspector",
  "live:META-DEC-05 load-more",
  "live:META-DEC-13 open",
  "live:META-DEC-17 search",
  "live:INV-18 share-view",
  "gated:META-WF-02..08 menu",
  "live:META-WF-11 keep",
  "live:META-WF-11 reapply",
  "gated:META-WRITE-01",
  "gated:META-WRITE-01 open-manual",
  "live:META-WRITE-06 rerun",
  "gated:META-WRITE-02 continue",
  "gated:META-WRITE-02 submit",
  "live:META-WRITE-08 copy-receipt",
  "gated:META-INTEL-09 run-snapshot",
  "live:META-INTEL-07 respond",
  "live:META-HIST-05 filter",
  "live:META-HIST-05 search",
  "live:META-HIST-05 cursor",
  "live:META-HIST-06 replay",
  "gated:AUTO-01A engage",
  "gated:AUTO-02 release",
  "gated:AUTO-03 mode",
  "live:CREATIVE-02 open",
  "live:CREATIVE-02 back",
  "live:CREATIVE-02 carousel-dot",
  "live:CREATIVE-07 brief",
  "live:CREATIVE-07 status",
  "live:CREATIVE-10 share",
  "live:CREATIVE-10 expiry",
  "live:CREATIVE-11 tier",
  "live:CREATIVE-11 ack",
  "live:CREATIVE-10 mint",
  "disabled:CREATIVE-10 mint",
  "live:CREATIVE-10 revoke",
  "live:CREATIVE-10 rotate",
  "live:CREATIVE-12 preset",
  "live:CREATIVE-12 sort",
  "live:CREATIVE-13 filter",
  "live:LAUNCH-01 fix",
  "live:LAUNCH-02 fix",
  "live:LAUNCH-03 duplicate",
  "gated:LAUNCH-03 delete",
  "live:LAUNCH-05 validate",
  "disabled:LAUNCH-06 launch",
  "disabled:LAUNCH-07 add",
  "live:GOOGLE-13 bucket",
  "live:GOOGLE-16 open-card",
  "live:GOOGLE-26 dismiss",
  "live:GOOGLE-28 mark-applied",
  "live:GOOGLE-30 deeplink",
  "live:GOOGLE-32 portfolio",
  "live:GOOGLE-ESC-01 copy",
  "live:GOOGLE-ESC-01 copy-all",
  "live:GOOGLE-ESC-01 csv",
  "live:GOOGLE-ESC-01 csv-all",
  "gated:SEO-04 run",
  "live:REPORT-05 source-toggle",
  "disabled:REPORT-06 source-unavailable",
  "live:REPORT-13 new",
  "live:REPORT-08 open",
  "live:REPORT-08 retry",
  "live:REPORT-02 edit",
  "live:REPORT-01 duplicate",
  "gated:REPORT-01 delete",
  "live:REPORT-03 keyboard-mode",
  "live:REPORT-03 widget-select",
  "live:REPORT-03 nudge-move",
  "live:REPORT-03 nudge-resize",
  "live:REPORT-03 undo",
  "live:REPORT-03 exit",
  "live:REPORT-04 csv",
  "live:REPORT-07 breakdown",
  "live:MOBILE-01",
  "live:MOBILE-02 scope-sheet",
  "gated:SCOPE-01 delete",
  "gated:TEAM-02 role",
  "gated:TEAM-03",
  "gated:TEAM-04",
  "gated:TEAM-04 invite",
  "gated:TEAM-05 approve",
  "gated:TEAM-05 deny",
  "gated:INTEGRATION-09",
  "gated:ADMIN-12 repair",
  "disabled:INV-24 reviewer-block",
  "live:SEO-01 load-more",
  "live:REPORT-01 load-more",
  "live:media-play",
  "live:media-retry",
] as const;

export const GENERATED_CONTRACT_EVENTS: readonly string[] = [
  "signup_opened",
  "login_field_input",
  "login_field_input",
  "login_submit",
  "oauth_google_start",
  "oauth_facebook_start",
  "password_reset_requested",
  "demo_entered",
  "user_menu_opened",
  "scope_switched",
  "business_switch_opened",
  "profile_edited",
  "profile_edited",
  "password_change_input",
  "password_change_input",
  "password_changed",
  "sessions_revoke_opened",
  "dialog_cancelled",
  "overlay_closed",
  "dialog_done",
  "tab_selected",
  "lane_selected",
  "nav_item_selected",
  "nav_drawer_opened",
  "nav_drawer_closed",
  "chart_table_toggled",
  "account_picker_opened",
  "account_assign_opened",
  "ga4_property_reassign",
  "sc_site_selected",
  "window_changed",
  "search_focused",
  "client_search_input",
  "search_result_opened",
  "agency_withheld_opened",
  "agency_client_opened",
  "agency_clients_paged",
  "integration_detail_opened",
  "reconnect_started",
  "connect_started",
  "connect_started",
  "account_assign_opened",
  "account_checkbox_toggled",
  "assignment_saved",
  "integration_detail_opened",
  "target_pack_edited",
  "cost_model_edited",
  "econ_divergence_opened",
  "language_changed",
  "public_nav_opened",
  "public_contact_opened",
  "lane_selected",
  "level_changed",
  "decision_inspector_opened",
  "decision_list_paged",
  "inactive_assets_opened",
  "entity_search_focused",
  "view_link_copied",
  "triage_event",
  "conflict_kept_mine",
  "conflict_took_server",
  "write_sheet_opened",
  "write_sheet_opened",
  "write_preflight_rerun",
  "write_confirm_opened",
  "write_submitted",
  "receipt_copied",
  "snapshot_run_now",
  "intel_prompt_answered",
  "history_filtered",
  "history_searched",
  "history_paged",
  "history_replayed",
  "meta_stop_engage",
  "meta_stop_release",
  "automation_mode_changed",
  "creative_opened",
  "creative_back_to_decision",
  "carousel_card_selected",
  "brief_created",
  "brief_status_changed",
  "share_dialog_opened",
  "share_expiry_changed",
  "share_tier_selected",
  "share_buyer_ack",
  "share_minted",
  "none",
  "share_revoked",
  "share_rotated",
  "creative_preset_changed",
  "creative_sorted",
  "creative_filtered",
  "launch_blocker_opened",
  "launch_blocker_opened",
  "template_duplicated",
  "template_deleted",
  "draft_validated",
  "none",
  "none",
  "advisor_bucket_selected",
  "change_card_opened",
  "advisor_dismissed",
  "plan_marked_applied",
  "google_deeplink_opened",
  "portfolio_mode_opened",
  "google_escape_copy",
  "google_escape_copy",
  "google_escape_csv",
  "google_escape_csv",
  "seo_ai_run",
  "builder_source_toggled",
  "none",
  "report_created_from_template",
  "report_opened",
  "widget_retried",
  "report_edit_opened",
  "report_duplicated",
  "report_deleted",
  "builder_keyboard_mode",
  "builder_widget_selected",
  "builder_widget_nudged",
  "builder_widget_resized",
  "builder_undo",
  "builder_mode_exited",
  "csv_export",
  "breakdown_toggled",
  "meta_tier0_triage_start",
  "stale_freshness_disclosed",
  "business_delete_started",
  "member_role_changed",
  "member_removed",
  "invite_action",
  "invite_sent",
  "access_request_approved",
  "access_request_denied",
  "disconnect_started",
  "ops_repair_started",
  "none",
  "seo_findings_paged",
  "report_list_paged",
  "share_media_played",
  "media_retried",
] as const;

export const GENERATED_REPORT_SOURCES: readonly {
  readonly id: ReportSourceId;
  readonly kind: string;
}[] = [
  { id: "overview_summary", kind: "renderable" },
  { id: "overview_trend", kind: "renderable" },
  { id: "channel_attribution", kind: "renderable" },
  { id: "meta_campaigns", kind: "renderable" },
  { id: "google_campaigns", kind: "renderable" },
  { id: "shopify_data", kind: "coming_soon" },
  { id: "ga4_data", kind: "coming_soon" },
  { id: "search_console_data", kind: "coming_soon" },
  { id: "klaviyo_data", kind: "coming_soon" },
] as const;

export type InstrumentationSurface =
  | "pub_home"
  | "pub_about"
  | "pub_product"
  | "pub_pricing"
  | "pub_contact"
  | "pub_privacy"
  | "pub_terms"
  | "pub_security"
  | "pub_ai_transparency"
  | "auth_login"
  | "auth_signup"
  | "auth_forgot_password"
  | "auth_reset_password"
  | "auth_demo"
  | "auth_invite"
  | "auth_select_business"
  | "auth_business_new"
  | "me_account_security"
  | "me_language"
  | "auth_shopify_connect"
  | "agency_desk_today"
  | "agency_desk_clients"
  | "agency_desk_withheld"
  | "client_home"
  | "meta_decisions"
  | "meta_intelligence"
  | "meta_launchpad"
  | "meta_automation"
  | "meta_history"
  | "creative_performance"
  | "creative_detail"
  | "creative_briefs"
  | "creative_inbox"
  | "creative_copies"
  | "creative_landing_pages"
  | "creative_shares"
  | "google_overview"
  | "google_advisor"
  | "google_search"
  | "google_products"
  | "google_assets_audiences"
  | "google_plan"
  | "analytics_ga4_shopify"
  | "analytics_landing_pages"
  | "analytics_seo"
  | "analytics_geo"
  | "reports_library"
  | "reports_new"
  | "reports_view"
  | "reports_edit"
  | "reports_print"
  | "manage_integrations"
  | "manage_integrations_callback"
  | "manage_team"
  | "manage_business"
  | "manage_plan"
  | "ops_overview"
  | "ops_activity"
  | "ops_auth_health"
  | "ops_businesses"
  | "ops_business_detail"
  | "ops_discounts"
  | "ops_discount_new"
  | "ops_discount_detail"
  | "ops_integrations"
  | "ops_release_authority"
  | "ops_revenue_risk"
  | "ops_subscriptions"
  | "ops_sync_health"
  | "ops_system_capacity"
  | "ops_users"
  | "ops_user_detail"
  | "share_creative"
  | "share_report";

export type InstrumentationEventName =
  | "screen_view";

export type InstrumentationPropertyKey =
  | "account_id"
  | "actor_role"
  | "agency_scope"
  | "business_id"
  | "code_id"
  | "creative_id"
  | "provider"
  | "report_id"
  | "surface"
  | "token_hash"
  | "ts"
  | "user_id"
  | "width_bucket";

export interface GeneratedInstrumentationRow {
  readonly leaf: LeafId;
  readonly surface: InstrumentationSurface;
  readonly event: InstrumentationEventName;
  /** True only for pre-auth public surfaces. */
  readonly anonymous: boolean;
  readonly properties: readonly InstrumentationPropertyKey[];
}

/** One row per canonical screen: the closed emitter allowlist (INSTR-01). */
export const GENERATED_INSTRUMENTATION: readonly GeneratedInstrumentationRow[] = [
  {
    leaf: "L-PUB-ROOT",
    surface: "pub_home",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-PUB-ABOUT",
    surface: "pub_about",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-PUB-PRODUCT",
    surface: "pub_product",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-PUB-PRICING",
    surface: "pub_pricing",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-PUB-CONTACT",
    surface: "pub_contact",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-PUB-PRIVACY",
    surface: "pub_privacy",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-PUB-TERMS",
    surface: "pub_terms",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-PUB-SECURITY",
    surface: "pub_security",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-PUB-AITRANS",
    surface: "pub_ai_transparency",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-AUTH-LOGIN",
    surface: "auth_login",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-AUTH-SIGNUP",
    surface: "auth_signup",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-AUTH-FORGOT",
    surface: "auth_forgot_password",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-AUTH-RESET",
    surface: "auth_reset_password",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-AUTH-DEMO",
    surface: "auth_demo",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-AUTH-INVITE",
    surface: "auth_invite",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-AUTH-SELBIZ",
    surface: "auth_select_business",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-AUTH-NEWBIZ",
    surface: "auth_business_new",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-ME-ACCOUNT",
    surface: "me_account_security",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-ME-LANG",
    surface: "me_language",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-AUTH-SHOPIFY",
    surface: "auth_shopify_connect",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-A-DESK",
    surface: "agency_desk_today",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "agency_scope", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-A-CLIENTS",
    surface: "agency_desk_clients",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "agency_scope", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-A-WITHHELD",
    surface: "agency_desk_withheld",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "agency_scope", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-HOME",
    surface: "client_home",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-META-DEC",
    surface: "meta_decisions",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-META-INTEL",
    surface: "meta_intelligence",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-META-LAUNCH",
    surface: "meta_launchpad",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-META-AUTO",
    surface: "meta_automation",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-META-HIST",
    surface: "meta_history",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-CR-PERF",
    surface: "creative_performance",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-CR-DETAIL",
    surface: "creative_detail",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "creative_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-CR-BRIEFS",
    surface: "creative_briefs",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-CR-INBOX",
    surface: "creative_inbox",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-CR-COPIES",
    surface: "creative_copies",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-CR-LP",
    surface: "creative_landing_pages",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-CR-SHARES",
    surface: "creative_shares",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-G-OVER",
    surface: "google_overview",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-G-ADV",
    surface: "google_advisor",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-G-SEARCH",
    surface: "google_search",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-G-PROD",
    surface: "google_products",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-G-ASSETS",
    surface: "google_assets_audiences",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-G-PLAN",
    surface: "google_plan",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-AN-GA",
    surface: "analytics_ga4_shopify",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-AN-LP",
    surface: "analytics_landing_pages",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-AN-SEO",
    surface: "analytics_seo",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-AN-GEO",
    surface: "analytics_geo",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-REP",
    surface: "reports_library",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-REP-NEW",
    surface: "reports_new",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-REP-VIEW",
    surface: "reports_view",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "report_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-REP-EDIT",
    surface: "reports_edit",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "report_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-REP-PRINT",
    surface: "reports_print",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "report_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-M-INT",
    surface: "manage_integrations",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-M-CB",
    surface: "manage_integrations_callback",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "provider", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-M-TEAM",
    surface: "manage_team",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-M-BIZ",
    surface: "manage_business",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-C-M-PLAN",
    surface: "manage_plan",
    event: "screen_view",
    anonymous: false,
    properties: ["account_id", "actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-OVER",
    surface: "ops_overview",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-ACT",
    surface: "ops_activity",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-AUTH",
    surface: "ops_auth_health",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-BIZ",
    surface: "ops_businesses",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-BIZ-D",
    surface: "ops_business_detail",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "business_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-DISC",
    surface: "ops_discounts",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-DISC-N",
    surface: "ops_discount_new",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-DISC-D",
    surface: "ops_discount_detail",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "code_id", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-INT",
    surface: "ops_integrations",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-REL",
    surface: "ops_release_authority",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-REV",
    surface: "ops_revenue_risk",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-SUBS",
    surface: "ops_subscriptions",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-SYNC",
    surface: "ops_sync_health",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-CAP",
    surface: "ops_system_capacity",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-USERS",
    surface: "ops_users",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "width_bucket"],
  },
  {
    leaf: "L-OPS-USER-D",
    surface: "ops_user_detail",
    event: "screen_view",
    anonymous: false,
    properties: ["actor_role", "surface", "ts", "user_id", "width_bucket"],
  },
  {
    leaf: "L-SH-CREATIVE",
    surface: "share_creative",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "token_hash", "ts", "width_bucket"],
  },
  {
    leaf: "L-SH-REPORT",
    surface: "share_report",
    event: "screen_view",
    anonymous: true,
    properties: ["actor_role", "surface", "token_hash", "ts", "width_bucket"],
  },
] as const;

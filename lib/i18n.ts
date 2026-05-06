export type AppLanguage = "en" | "tr";

export const DEFAULT_LANGUAGE: AppLanguage = "en";
export const LANGUAGE_COOKIE_NAME = "adsecute_locale";

export const LANGUAGE_OPTIONS: Array<{
  value: AppLanguage;
  label: string;
  nativeLabel: string;
}> = [{ value: "en", label: "English", nativeLabel: "English" }];

export const NON_TRANSLATABLE_TERMS = [
  "ROAS",
  "CTR",
  "CPC",
  "CPA",
  "CPM",
  "CVR",
  "AOV",
  "CAC",
  "MER",
  "LTV",
  "PMax",
  "Search",
  "Shopping",
  "Display",
  "GA4",
  "Meta",
  "Google Ads",
  "Klaviyo",
  "Shopify",
  "FAQ",
  "CTA",
] as const;

export function isAppLanguage(value: string | null | undefined): value is AppLanguage {
  return value === "en" || value === "tr";
}

export function getLanguageFromCookieValue(value: string | null | undefined): AppLanguage {
  return "en";
}

export function getPreferredLanguage(input: {
  userLanguage?: string | null;
  cookieLanguage?: string | null;
}): AppLanguage {
  return "en";
}

export function syncLanguageCookie(value: AppLanguage) {
  if (typeof document === "undefined") return;
  document.cookie = `${LANGUAGE_COOKIE_NAME}=${value}; path=/; max-age=31536000; samesite=lax`;
}

export function readLanguageCookie() {
  if (typeof document === "undefined") return null;
  const value = document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${LANGUAGE_COOKIE_NAME}=`))
    ?.split("=")[1];
  return isAppLanguage(value) ? value : null;
}

export function getLanguageDisplayName(_language: AppLanguage) {
  return "English";
}

export function getAiNarrativeLanguage(_language: AppLanguage) {
  return "English";
}

export function getNonTranslatableTermsInstruction(_language: AppLanguage) {
  return `Never translate these terms and preserve them exactly: ${NON_TRANSLATABLE_TERMS.join(", ")}.`;
}

export function getNativeNarrativeStyleInstruction(_language: AppLanguage) {
  return "Write in concise, natural operator English. Do not sound like a translated document.";
}

export function getCanonicalMetricLabel(label: string) {
  const exactMatch = NON_TRANSLATABLE_TERMS.find((term) => term.toLowerCase() === label.toLowerCase());
  return exactMatch ?? label;
}

export const translations = {
  en: {
    common: {
      ai: "AI",
      fallback: "Fallback",
      retry: "Retry",
      refresh: "Refresh",
      loading: "Loading...",
      regenerate: "Regenerate",
      generating: "Generating...",
      reRun: "Re-run",
      noItems: "No items.",
    },
    navigation: {
      main: "Main",
      platforms: "Platforms",
      launchpad: "Launchpad",
      assets: "Assets",
      manage: "Manage",
      overview: "Overview",
      commandCenter: "Command Center",
      commercialTruth: "Commercial Truth",
      meta: "Meta",
      google: "Google",
      googleAds: "Google Ads",
      tikTok: "TikTok",
      pinterest: "Pinterest",
      snapchat: "Snapchat",
      klaviyo: "Klaviyo",
      analytics: "Analytics",
      geoIntelligence: "GEO Intelligence",
      seoIntelligence: "SEO Intelligence",
      creatives: "Creatives",
      landingPages: "Landing Pages",
      copies: "Copies",
      reports: "Reports",
      integrations: "Integrations",
      team: "Team",
      settings: "Settings",
      selectBusiness: "Select Business",
      createBusiness: "Create Business",
    },
    layout: {
      toggleSidebar: "Toggle sidebar",
      notifications: "Notifications",
      teamAccess: "Team access",
      accountSettings: "Account settings",
      helpDocs: "Help Docs",
      whatsNew: "What's new",
      signingOut: "Signing out...",
      signOut: "Sign out",
      signOutError: "Could not sign out. Please try again.",
      createBusiness: "Create business",
      selectBusiness: "Select business",
      switchBusiness: "Switch business",
      manageBusinesses: "Manage businesses",
      createNewBusiness: "Create new business",
      upgradeToUnlock: "Upgrade to {plan} to unlock",
      accountLevelRecommendation: "Account-level recommendation",
      jumpToCampaign: "Jump to campaign",
      showDetails: "Analysis details",
      hideDetails: "Hide details",
    },
    login: {
      subtitle: "Sign in to your account to continue",
      email: "Email",
      password: "Password",
      rememberMe: "Remember me",
      signingIn: "Signing in...",
      signIn: "Sign in",
      noAccount: "No account yet?",
      createOne: "Create one",
      signInWithGoogle: "Sign in with Google",
    },
    signup: {
      title: "Create account",
      inviteSubtitle: "Create your account to accept this team invite.",
      defaultSubtitle: "Sign up and create your first business workspace.",
      fullName: "Full name",
      email: "Email",
      password: "Password (min 8 chars)",
      businessName: "Business name",
      creating: "Creating account...",
      signUp: "Sign up",
      or: "or",
      signUpWithGoogle: "Sign up with Google",
      signUpWithFacebook: "Sign up with Facebook",
      alreadyHaveAccount: "Already have an account?",
      signIn: "Sign in",
    },
    language: {
      title: "Choose your language",
      subtitle: "You can change this later from settings.",
      continue: "Continue",
      skip: "Skip for now",
      current: "Current selection",
    },
    settings: {
      languageTitle: "Language",
      languageDescription: "Choose the language used in supported Adsecute screens.",
      languageLabel: "App language",
      languageHint: "This preference is saved to your account and synced through a cookie for faster rendering.",
      saveLanguage: "Apply language",
      languageSaved: "Language updated.",
    },
    aiBrief: {
      title: "Today's AI Brief",
      errorPrefix: "Could not load AI daily brief.",
      empty: "No AI brief available yet. Once the scheduled AI run completes, this section will populate automatically.",
      insightDate: "Insight date",
      opportunities: "Opportunities",
      risks: "Risks",
      recommendations: "Recommendations",
    },
    landingPages: {
      aiInsight: "AI Insight",
      uxAudit: "UX Audit",
      uxAuditDescription: "UX findings, friction points, and improvement opportunities for this landing page.",
      runAuditPrompt: "Run AI when you want a focused UX audit for this landing page.",
      runAudit: "Run UX audit",
      auditLoadError: "UX audit could not be loaded for this page.",
      retryAudit: "Retry UX audit",
      rerunAudit: "Re-run UX audit",
      criticalFindings: "Critical findings",
      quickWins: "Quick wins",
      uxRisks: "UX risks",
      decisionScore: "Decision score",
      confidence: "Confidence",
      pageType: "Page type",
      primaryLeak: "Primary leak",
      strengths: "Strengths",
      issues: "Issues",
      priorityActions: "Priority actions",
      risks: "Risks",
      noStrongAdvantages: "No strong advantages stand out yet.",
      noDominantIssue: "No single issue dominates this page right now.",
      noUnusualRisks: "No unusual risks surfaced beyond normal optimization variance.",
      trafficQuality: "Traffic quality",
      discovery: "Discovery",
      intent: "Intent",
      checkout: "Checkout",
      revenueEfficiency: "Revenue efficiency",
      trafficQualityDescription: "Measures engagement depth and browsing quality.",
      discoveryDescription: "Shows how well sessions move into product exploration.",
      intentDescription: "Shows whether product views turn into add-to-cart intent.",
      checkoutDescription: "Captures momentum from cart into completed checkout.",
      revenueEfficiencyDescription: "Combines purchase efficiency with order value quality.",
    },
    creativeDetail: {
      aiInterpretation: "AI strategy interpretation",
      generateInterpretation: "Generate AI interpretation",
      analyzing: "Analyzing report...",
      unavailable: "AI interpretation is temporarily unavailable.",
      opportunities: "Opportunities",
      risks: "Risks",
      nextActions: "Next actions",
      refreshInterpretation: "Refresh interpretation",
    },
    meta: {
      title: "Recommendations",
      loading: "Building multi-window recommendations...",
      loadError: "Could not build recommendations right now.",
      noStrongSignal: "Multi-window engine does not see a strong intervention signal yet.",
      validatedAgainst: "Multi-window Meta decision engine validated against selected range + 3/7/14/30/90/history.",
      conservativeRules: "Conservative rules",
      accountSummary: "Account Summary",
      operatingMode: "Operating Mode",
      currentRegime: "Current Regime",
      recommendedMode: "Recommended Mode",
      recommendedAction: "Recommended Action",
      decisionModel: "Decision model",
      coreVerdict: "Core verdict",
      selectedRangeNote: "Selected range note",
      historicalSupport: "Historical support",
      defensiveBidBand: "Defensive Bid Band",
      scaleBidBand: "Scale Bid Band",
      rebuild: "Rebuild",
      recommended: "Recommended",
      promoteToScaling: "Promote To Scaling",
      keepInTest: "Keep In TEST",
      keepOutOfScaling: "Keep Out Of Scaling",
      targetLane: "Target lane",
      scalingGeoCluster: "Scaling Geo Cluster",
      testGeoCluster: "TEST Geo Cluster",
      keepSeparate: "Keep Separate",
      confidenceSuffix: "confidence",
      prioritySuffix: "priority",
      comparedWithin: "compared within",
      historicalRegimePrefix: "historical regime",
      accountLevelRecommendation: "Account-level recommendation",
      jumpToCampaign: "Jump to campaign",
      cards: "cards",
      card: "card",
      operatingModel: "Operating Model",
      operatingModelDescription: "Seasonality, regime fit, and rebuild direction.",
      bidding: "Bidding",
      biddingDescription: "Bid method, safer ranges, and constraint changes.",
      scaling: "Scaling",
      scalingDescription: "Scale candidates and controlled budget expansion.",
      budgetAllocation: "Budget Allocation",
      budgetAllocationDescription: "Where budget should concentrate inside comparable cohorts.",
      structure: "Structure",
      structureDescription: "Campaign lanes, creative deployment, and geo shape.",
      lensVolume: "Volume",
      lensProfitability: "Profitability",
      lensStructure: "Structure",
      decisionAct: "Act",
      decisionTest: "Test",
      decisionWatch: "Watch",
      confidenceHigh: "High",
      confidenceMedium: "Medium",
      confidenceLow: "Low",
      priorityHigh: "High",
      priorityMedium: "Medium",
      priorityLow: "Low",
    },
  },
} as const;

export function getTranslations(_language?: AppLanguage) {
  return translations.en;
}

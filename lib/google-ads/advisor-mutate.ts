import { assertGoogleAdsAccountAuthority } from "@/lib/google-ads/account-authority";
import { GOOGLE_CONFIG } from "@/lib/oauth/google-config";
import { getIntegration, upsertIntegration } from "@/lib/integrations";
import { refreshGoogleAccessToken } from "@/lib/google-ads-accounts";
import { readProviderAccountSnapshot } from "@/lib/provider-account-snapshots";
import { fetchWithTimeout } from "@/lib/http-fetch-with-timeout";

type MutateHttpMethod = "POST";

// Google Ads mutate/search are small request/response calls; bound them so a
// stalled socket can never park the single-threaded sync worker.
const GOOGLE_ADS_MUTATE_TIMEOUT_MS = 30_000;

export interface AddNegativeKeywordPayload {
  campaignId: string;
  negativeKeywords: string[];
  matchType: "EXACT";
}

export interface PauseAssetPayload {
  assetId: string;
  assetGroupId: string;
  fieldType: string;
}

export interface PauseAdPayload {
  adId: string;
}

export interface CampaignBudgetMutationOperation {
  campaignId: string;
  campaignBudgetResourceName: string;
  previousAmount: number;
  proposedAmount: number;
  deltaPercent: number;
}

export interface AdjustCampaignBudgetPayload extends CampaignBudgetMutationOperation {
  operations?: CampaignBudgetMutationOperation[];
}

export interface AdjustPortfolioTargetPayload {
  portfolioBidStrategyResourceName: string;
  portfolioTargetType: "tROAS" | "tCPA";
  previousValue: number;
  proposedValue: number;
  deltaPercent: number;
}

export type AdvisorMutatePayload =
  | { actionType: "add_negative_keyword"; payload: AddNegativeKeywordPayload }
  | { actionType: "pause_asset"; payload: PauseAssetPayload }
  | { actionType: "pause_ad"; payload: PauseAdPayload }
  | { actionType: "adjust_campaign_budget"; payload: AdjustCampaignBudgetPayload }
  | { actionType: "adjust_shared_budget"; payload: AdjustCampaignBudgetPayload }
  | { actionType: "adjust_portfolio_target"; payload: AdjustPortfolioTargetPayload };

export interface AdvisorMutationResult {
  actionType: AdvisorMutatePayload["actionType"];
  resourceNames: string[];
  rawResponse: Record<string, unknown>;
}

function normalizeCustomerId(value: string) {
  return value.replace(/^customers\//, "").replace(/\D/g, "");
}

async function resolveGoogleAccessToken(businessId: string) {
  const integration = await getIntegration(businessId, "google");
  if (!integration?.access_token) {
    throw new Error("Google Ads integration not found or not connected.");
  }

  let accessToken = integration.access_token;
  if (integration.token_expires_at) {
    const expiresAt = new Date(integration.token_expires_at);
    if (new Date() >= expiresAt && integration.refresh_token) {
      const refreshed = await refreshGoogleAccessToken(integration.refresh_token);
      await upsertIntegration({
        businessId,
        provider: "google",
        status: "connected",
        accessToken: refreshed.accessToken,
        refreshToken: integration.refresh_token,
        tokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      });
      accessToken = refreshed.accessToken;
    }
  }

  return accessToken;
}

async function loginCustomerIdCandidates(businessId: string, accountId: string) {
  const snapshot = await readProviderAccountSnapshot({
    businessId,
    provider: "google",
  }).catch(() => null);
  const normalized = normalizeCustomerId(accountId);
  const managers = (snapshot?.accounts ?? [])
    .filter((account) => account.isManager)
    .map((account) => normalizeCustomerId(account.id))
    .filter((candidate) => candidate && candidate !== normalized);
  return [undefined, ...Array.from(new Set(managers)).slice(0, 3)];
}

async function googleAdsMutateRequest(input: {
  businessId: string;
  accountId: string;
  path: string;
  body: Record<string, unknown>;
  validateOnly?: boolean;
}) {
  // The lowest common boundary of every advisor writeback: apply, batch apply,
  // rollback and validate-only all arrive here, with an `accountId` taken
  // straight from the request body and the shared business credential. Without
  // this, any customer that credential could reach was writable.
  //
  // Validate-only is guarded too: it is still a provider call against an account
  // that may no longer be selected.
  await assertGoogleAdsAccountAuthority({
    businessId: input.businessId,
    accountId: input.accountId,
  });
  const accessToken = await resolveGoogleAccessToken(input.businessId);
  const accountId = normalizeCustomerId(input.accountId);
  const url = `${GOOGLE_CONFIG.adsApiBase}/customers/${accountId}/${input.path}`;
  let lastError: string | null = null;

  const candidates = await loginCustomerIdCandidates(input.businessId, accountId);
  for (const loginCustomerId of candidates) {
    // Re-read AFTER the token refresh and the manager-account resolution above,
    // and again before EVERY attempt. Both of those can take seconds — a token
    // refresh is a network round trip and candidate resolution reads a
    // discovery snapshot — and the loop retries against a different login
    // customer id, so "checked once at the top" leaves a window before each
    // attempt in which the account can be deselected.
    await assertGoogleAdsAccountAuthority({
      businessId: input.businessId,
      accountId: input.accountId,
    });
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST" satisfies MutateHttpMethod,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": GOOGLE_CONFIG.developerToken,
          "content-type": "application/json",
          Accept: "application/json",
          ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
        },
        body: JSON.stringify(input.body),
        cache: "no-store",
      },
      { timeoutMs: GOOGLE_ADS_MUTATE_TIMEOUT_MS, label: "Google Ads mutate" },
    );
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok && payload) {
      return payload;
    }
    lastError =
      String(
        payload?.error && typeof payload.error === "object"
          ? (payload.error as Record<string, unknown>).message ?? response.statusText
          : response.statusText
      ) || (input.validateOnly ? "Google Ads validate-only request failed." : "Google Ads mutate request failed.");
  }

  throw new Error(lastError ?? (input.validateOnly ? "Google Ads validate-only request failed." : "Google Ads mutate request failed."));
}

async function googleAdsSearchRequest(input: {
  businessId: string;
  accountId: string;
  query: string;
}) {
  // Rollback and preflight read current provider state through this helper
  // before deciding what to write, so it needs the same authority as the mutate
  // path — otherwise a deselected account is still readable through a live
  // credential from an execution surface.
  await assertGoogleAdsAccountAuthority({
    businessId: input.businessId,
    accountId: input.accountId,
  });
  const accessToken = await resolveGoogleAccessToken(input.businessId);
  const accountId = normalizeCustomerId(input.accountId);
  const url = `${GOOGLE_CONFIG.adsApiBase}/customers/${accountId}/googleAds:search`;
  let lastError: string | null = null;

  const searchCandidates = await loginCustomerIdCandidates(input.businessId, accountId);
  for (const loginCustomerId of searchCandidates) {
    await assertGoogleAdsAccountAuthority({
      businessId: input.businessId,
      accountId: input.accountId,
    });
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": GOOGLE_CONFIG.developerToken,
          "content-type": "application/json",
          Accept: "application/json",
          ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
        },
        body: JSON.stringify({ query: input.query }),
        cache: "no-store",
      },
      { timeoutMs: GOOGLE_ADS_MUTATE_TIMEOUT_MS, label: "Google Ads search" },
    );
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok && payload) {
      return payload;
    }
    lastError =
      String(
        payload?.error && typeof payload.error === "object"
          ? (payload.error as Record<string, unknown>).message ?? response.statusText
          : response.statusText
      ) || "Google Ads search request failed.";
  }

  throw new Error(lastError ?? "Google Ads search request failed.");
}

function escapeGaqlLiteral(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function budgetOperationsFromPayload(payload: AdjustCampaignBudgetPayload) {
  const operations = Array.isArray(payload.operations) && payload.operations.length > 0
    ? payload.operations
    : [payload];
  return operations.filter(
    (entry) =>
      Boolean(entry.campaignBudgetResourceName) &&
      Number.isFinite(Number(entry.previousAmount)) &&
      Number.isFinite(Number(entry.proposedAmount))
  );
}

function portfolioTargetUpdate(input: AdjustPortfolioTargetPayload) {
  if (input.portfolioTargetType === "tROAS") {
    return {
      update: {
        resourceName: input.portfolioBidStrategyResourceName,
        targetRoas: {
          targetRoas: Number(input.proposedValue),
        },
      },
      updateMask: "target_roas.target_roas",
    };
  }
  return {
    update: {
      resourceName: input.portfolioBidStrategyResourceName,
      targetCpa: {
        targetCpaMicros: Math.round(Number(input.proposedValue) * 1_000_000),
      },
    },
    updateMask: "target_cpa.target_cpa_micros",
  };
}

export async function validateAdvisorMutation(input: {
  businessId: string;
  accountId: string;
  action: AdvisorMutatePayload;
}) {
  switch (input.action.actionType) {
    case "add_negative_keyword": {
      const actionPayload = input.action.payload;
      await googleAdsMutateRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        path: "campaignCriteria:mutate",
        validateOnly: true,
        body: {
          validateOnly: true,
          operations: actionPayload.negativeKeywords.map((keyword) => ({
            create: {
              campaign: `customers/${normalizeCustomerId(input.accountId)}/campaigns/${actionPayload.campaignId}`,
              negative: true,
              keyword: {
                text: keyword,
                matchType: actionPayload.matchType,
              },
            },
          })),
        },
      });
      return;
    }
    case "pause_asset": {
      const actionPayload = input.action.payload;
      const resourceName = `customers/${normalizeCustomerId(input.accountId)}/assetGroupAssets/${actionPayload.assetGroupId}~${actionPayload.assetId}~${actionPayload.fieldType}`;
      await googleAdsMutateRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        path: "assetGroupAssets:mutate",
        validateOnly: true,
        body: {
          validateOnly: true,
          operations: [
            {
              update: {
                resourceName,
                status: "PAUSED",
              },
              updateMask: "status",
            },
          ],
        },
      });
      return;
    }
    case "pause_ad":
      throw new Error("Pause ad mutate is not enabled in Wave 10.");
    case "adjust_campaign_budget":
    case "adjust_shared_budget": {
      const operations = budgetOperationsFromPayload(input.action.payload);
      await googleAdsMutateRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        path: "campaignBudgets:mutate",
        validateOnly: true,
        body: {
          validateOnly: true,
          operations: operations.map((operation) => ({
            update: {
              resourceName: operation.campaignBudgetResourceName,
              amountMicros: Math.round(operation.proposedAmount * 1_000_000),
            },
            updateMask: "amount_micros",
          })),
        },
      });
      return;
    }
    case "adjust_portfolio_target": {
      const actionPayload = input.action.payload;
      await googleAdsMutateRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        path: "biddingStrategies:mutate",
        validateOnly: true,
        body: {
          validateOnly: true,
          operations: [portfolioTargetUpdate(actionPayload)],
        },
      });
      return;
    }
  }
}

export async function preflightAdvisorMutation(input: {
  businessId: string;
  accountId: string;
  action: AdvisorMutatePayload;
}) {
  await validateAdvisorMutation(input);

  switch (input.action.actionType) {
    case "add_negative_keyword":
      return { ok: true as const };
    case "pause_asset": {
      const actionPayload = input.action.payload;
      const resourceName = `customers/${normalizeCustomerId(input.accountId)}/assetGroupAssets/${actionPayload.assetGroupId}~${actionPayload.assetId}~${actionPayload.fieldType}`;
      const response = await googleAdsSearchRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        query: `SELECT asset_group_asset.resource_name, asset_group_asset.status FROM asset_group_asset WHERE asset_group_asset.resource_name = '${escapeGaqlLiteral(resourceName)}' LIMIT 1`,
      });
      const row = Array.isArray(response.results) ? response.results[0] : null;
      const assetGroupAsset =
        row && typeof row === "object" && row !== null
          ? (row as Record<string, unknown>).assetGroupAsset ?? (row as Record<string, unknown>).asset_group_asset
          : null;
      const status =
        assetGroupAsset && typeof assetGroupAsset === "object"
          ? String((assetGroupAsset as Record<string, unknown>).status ?? "")
          : "";
      if (!status) {
        throw new Error("preflight_drift: asset state could not be verified before mutate.");
      }
      if (status === "PAUSED") {
        throw new Error("preflight_drift: asset is already paused.");
      }
      return { ok: true as const };
    }
    case "pause_ad":
      throw new Error("Pause ad mutate is not enabled in Wave 10.");
    case "adjust_campaign_budget":
    case "adjust_shared_budget": {
      const operations = budgetOperationsFromPayload(input.action.payload);
      for (const operation of operations) {
        const response = await googleAdsSearchRequest({
          businessId: input.businessId,
          accountId: input.accountId,
          query: `SELECT campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign_budget WHERE campaign_budget.resource_name = '${escapeGaqlLiteral(operation.campaignBudgetResourceName)}' LIMIT 1`,
        });
        const row = Array.isArray(response.results) ? response.results[0] : null;
        const campaignBudget =
          row && typeof row === "object" && row !== null
            ? (row as Record<string, unknown>).campaignBudget ?? (row as Record<string, unknown>).campaign_budget
            : null;
        const amountMicros =
          campaignBudget && typeof campaignBudget === "object"
            ? Number((campaignBudget as Record<string, unknown>).amountMicros ?? (campaignBudget as Record<string, unknown>).amount_micros ?? NaN)
            : NaN;
        const currentAmount = amountMicros / 1_000_000;
        if (!Number.isFinite(currentAmount)) {
          throw new Error("preflight_drift: current budget amount could not be verified before mutate.");
        }
        if (Math.abs(currentAmount - Number(operation.previousAmount)) > 0.009) {
          throw new Error(
            `preflight_drift: current budget ${currentAmount.toFixed(2)} no longer matches expected baseline ${Number(operation.previousAmount).toFixed(2)}.`
          );
        }
      }
      return { ok: true as const };
    }
    case "adjust_portfolio_target": {
      const actionPayload = input.action.payload;
      const response = await googleAdsSearchRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        query: `SELECT bidding_strategy.resource_name, bidding_strategy.type, bidding_strategy.status, bidding_strategy.target_roas.target_roas, bidding_strategy.target_cpa.target_cpa_micros FROM bidding_strategy WHERE bidding_strategy.resource_name = '${escapeGaqlLiteral(actionPayload.portfolioBidStrategyResourceName)}' LIMIT 1`,
      });
      const row = Array.isArray(response.results) ? response.results[0] : null;
      const biddingStrategy =
        row && typeof row === "object" && row !== null
          ? (row as Record<string, unknown>).biddingStrategy ?? (row as Record<string, unknown>).bidding_strategy
          : null;
      const biddingStrategyRecord =
        biddingStrategy && typeof biddingStrategy === "object"
          ? (biddingStrategy as Record<string, unknown>)
          : null;
      const targetRoasRecord =
        biddingStrategyRecord?.targetRoas && typeof biddingStrategyRecord.targetRoas === "object"
          ? (biddingStrategyRecord.targetRoas as Record<string, unknown>)
          : biddingStrategyRecord?.target_roas && typeof biddingStrategyRecord.target_roas === "object"
            ? (biddingStrategyRecord.target_roas as Record<string, unknown>)
            : null;
      const targetCpaRecord =
        biddingStrategyRecord?.targetCpa && typeof biddingStrategyRecord.targetCpa === "object"
          ? (biddingStrategyRecord.targetCpa as Record<string, unknown>)
          : biddingStrategyRecord?.target_cpa && typeof biddingStrategyRecord.target_cpa === "object"
            ? (biddingStrategyRecord.target_cpa as Record<string, unknown>)
            : null;
      const targetRoas =
        targetRoasRecord ? Number(targetRoasRecord.targetRoas ?? targetRoasRecord.target_roas ?? NaN) : NaN;
      const targetCpaMicros =
        targetCpaRecord ? Number(targetCpaRecord.targetCpaMicros ?? targetCpaRecord.target_cpa_micros ?? NaN) : NaN;
      const currentValue =
        actionPayload.portfolioTargetType === "tROAS"
          ? targetRoas
          : targetCpaMicros / 1_000_000;
      if (!Number.isFinite(currentValue)) {
        throw new Error("preflight_drift: current portfolio target could not be verified before mutate.");
      }
      if (Math.abs(currentValue - Number(actionPayload.previousValue)) > 0.009) {
        throw new Error(
          `preflight_drift: current portfolio target ${currentValue.toFixed(2)} no longer matches expected baseline ${Number(actionPayload.previousValue).toFixed(2)}.`
        );
      }
      return { ok: true as const };
    }
  }
}

export async function executeAdvisorMutation(input: {
  businessId: string;
  accountId: string;
  action: AdvisorMutatePayload;
}) {
  switch (input.action.actionType) {
    case "add_negative_keyword": {
      const actionPayload = input.action.payload;
      const payload = await googleAdsMutateRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        path: "campaignCriteria:mutate",
        body: {
          operations: actionPayload.negativeKeywords.map((keyword) => ({
            create: {
              campaign: `customers/${normalizeCustomerId(input.accountId)}/campaigns/${actionPayload.campaignId}`,
              negative: true,
              keyword: {
                text: keyword,
                matchType: actionPayload.matchType,
              },
            },
          })),
        },
      });
      const results = Array.isArray(payload.results) ? payload.results : [];
      const resourceNames = results
        .map((entry) =>
          entry && typeof entry === "object"
            ? String((entry as Record<string, unknown>).resourceName ?? "")
            : ""
        )
        .filter(Boolean);
      return {
        actionType: input.action.actionType,
        resourceNames,
        rawResponse: payload,
      } satisfies AdvisorMutationResult;
    }
    case "pause_asset": {
      const actionPayload = input.action.payload;
      const resourceName = `customers/${normalizeCustomerId(input.accountId)}/assetGroupAssets/${actionPayload.assetGroupId}~${actionPayload.assetId}~${actionPayload.fieldType}`;
      const payload = await googleAdsMutateRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        path: "assetGroupAssets:mutate",
        body: {
          operations: [
            {
              update: {
                resourceName,
                status: "PAUSED",
              },
              updateMask: "status",
            },
          ],
        },
      });
      return {
        actionType: input.action.actionType,
        resourceNames: [resourceName],
        rawResponse: payload,
      } satisfies AdvisorMutationResult;
    }
    case "pause_ad":
      throw new Error("Pause ad mutate is not enabled in Wave 10.");
    case "adjust_campaign_budget":
    case "adjust_shared_budget": {
      const operations = budgetOperationsFromPayload(input.action.payload);
      const payload = await googleAdsMutateRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        path: "campaignBudgets:mutate",
        body: {
          operations: operations.map((operation) => ({
            update: {
              resourceName: operation.campaignBudgetResourceName,
              amountMicros: Math.round(operation.proposedAmount * 1_000_000),
            },
            updateMask: "amount_micros",
          })),
        },
      });
      return {
        actionType: input.action.actionType,
        resourceNames: operations.map((operation) => operation.campaignBudgetResourceName),
        rawResponse: payload,
      } satisfies AdvisorMutationResult;
    }
    case "adjust_portfolio_target": {
      const actionPayload = input.action.payload;
      const payload = await googleAdsMutateRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        path: "biddingStrategies:mutate",
        body: {
          operations: [portfolioTargetUpdate(actionPayload)],
        },
      });
      return {
        actionType: input.action.actionType,
        resourceNames: [actionPayload.portfolioBidStrategyResourceName],
        rawResponse: payload,
      } satisfies AdvisorMutationResult;
    }
  }
}

export async function rollbackAdvisorMutation(input: {
  businessId: string;
  accountId: string;
  actionType:
    | "remove_negative_keyword"
    | "enable_asset"
    | "enable_ad"
    | "restore_campaign_budget"
    | "restore_shared_budget"
    | "restore_portfolio_target";
  payload: Record<string, unknown>;
}) {
  switch (input.actionType) {
    case "remove_negative_keyword": {
      const resourceNames = Array.isArray(input.payload.resourceNames)
        ? input.payload.resourceNames.map((value) => String(value)).filter(Boolean)
        : [];
      if (resourceNames.length === 0) {
        throw new Error("No negative keyword resource names were recorded for rollback.");
      }
      const payload = await googleAdsMutateRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        path: "campaignCriteria:mutate",
        body: {
          operations: resourceNames.map((resourceName) => ({
            remove: resourceName,
          })),
        },
      });
      return payload;
    }
    case "enable_asset": {
      const resourceNames = Array.isArray(input.payload.resourceNames)
        ? input.payload.resourceNames.map((value) => String(value)).filter(Boolean)
        : [];
      const singleResourceName = String(input.payload.resourceName ?? "");
      const targets = resourceNames.length > 0 ? resourceNames : singleResourceName ? [singleResourceName] : [];
      if (targets.length === 0) {
        throw new Error("No asset resource name was recorded for rollback.");
      }
      const payload = await googleAdsMutateRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        path: "assetGroupAssets:mutate",
        body: {
          operations: targets.map((resourceName) => ({
            update: {
              resourceName,
              status: "ENABLED",
            },
            updateMask: "status",
          })),
        },
      });
      return payload;
    }
    case "enable_ad":
      throw new Error("Enable ad rollback is not enabled in Wave 10.");
    case "restore_campaign_budget":
    case "restore_shared_budget": {
      const budgetOperations = Array.isArray(input.payload.operations)
        ? input.payload.operations
            .map((entry) => {
              const record = entry as Record<string, unknown>;
              return {
                campaignBudgetResourceName: String(record.campaignBudgetResourceName ?? ""),
                previousAmount: Number(record.previousAmount ?? NaN),
              };
            })
            .filter(
              (entry) =>
                Boolean(entry.campaignBudgetResourceName) && Number.isFinite(entry.previousAmount)
            )
        : [];
      const singleResourceName = String(input.payload.campaignBudgetResourceName ?? "");
      const singlePreviousAmount = Number(input.payload.previousAmount ?? NaN);
      const operations =
        budgetOperations.length > 0
          ? budgetOperations
          : singleResourceName && Number.isFinite(singlePreviousAmount)
            ? [{ campaignBudgetResourceName: singleResourceName, previousAmount: singlePreviousAmount }]
            : [];
      if (operations.length === 0) {
        throw new Error("Budget rollback requires the original campaign budget resource and amount.");
      }
      const payload = await googleAdsMutateRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        path: "campaignBudgets:mutate",
        body: {
          operations: operations.map((operation) => ({
            update: {
              resourceName: operation.campaignBudgetResourceName,
              amountMicros: Math.round(operation.previousAmount * 1_000_000),
            },
            updateMask: "amount_micros",
          })),
        },
      });
      return payload;
    }
    case "restore_portfolio_target": {
      const portfolioBidStrategyResourceName = String(input.payload.portfolioBidStrategyResourceName ?? "");
      const portfolioTargetType = String(input.payload.portfolioTargetType ?? "");
      const previousValue = Number(input.payload.previousValue ?? NaN);
      if (!portfolioBidStrategyResourceName || !Number.isFinite(previousValue)) {
        throw new Error("Portfolio rollback requires the original strategy resource and target value.");
      }
      const payload = await googleAdsMutateRequest({
        businessId: input.businessId,
        accountId: input.accountId,
        path: "biddingStrategies:mutate",
        body: {
          operations: [
            portfolioTargetUpdate({
              portfolioBidStrategyResourceName,
              portfolioTargetType: portfolioTargetType === "tCPA" ? "tCPA" : "tROAS",
              previousValue,
              proposedValue: previousValue,
              deltaPercent: 0,
            }),
          ],
        },
      });
      return payload;
    }
  }
}

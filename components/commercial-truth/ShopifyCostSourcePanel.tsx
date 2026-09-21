"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Search,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { FieldHelpTip } from "@/components/commercial-truth/FieldHelpTip";
import styles from "@/components/commercial-truth/ShopifyCostSourcePanel.module.css";
import {
  CONTRIBUTION_COST_FAMILIES,
  costFamilyMeta,
  marginImpliedFamilies,
} from "@/lib/commerce-cost/taxonomy";
import type {
  CommerceCostSourcePolicy,
  CommerceCostStructure,
  CostFamily,
  ProductCostAuthority,
  ShopifyUnitCostMeaning,
  ShopifyUnitCostPolicy,
} from "@/src/types/commerce-cost";

interface CostRow {
  productId: string;
  variantId: string;
  inventoryItemId: string;
  sku: string | null;
  productTitle: string | null;
  variantTitle: string | null;
  unitCost: string | null;
  currencyCode: string | null;
  sourceUpdatedAt: string | null;
  observedAt: string;
}

interface CostCatalogResponse {
  storage?: { ready?: boolean; missingTables?: string[] };
  connection?: {
    connected?: boolean;
    shopDomain?: string | null;
    scopeReady?: boolean;
    missingScopes?: string[];
  };
  summary?: {
    totalVariants?: number;
    costedVariants?: number;
    missingCostVariants?: number;
    coveragePercent?: number | null;
    currencyCounts?: Array<{ currencyCode: string; count: number }>;
    lastSyncedAt?: string | null;
  };
  rows?: CostRow[];
  matchedVariants?: number;
  limit?: number;
  offset?: number;
  message?: string;
}

const AUTHORITY_OPTIONS: ReadonlyArray<{
  value: ProductCostAuthority;
  label: string;
  detail: string;
}> = [
  {
    value: "shopify_unit_cost",
    label: "Use Shopify product costs",
    detail: "Best when Shopify’s Cost per item is maintained for each product.",
  },
  {
    value: "manual_components",
    label: "Use Adsecute cost rules",
    detail: "Best when you know a store-wide rate, margin, formula or supplier cost.",
  },
  {
    value: "hybrid",
    label: "Shopify first, fill gaps in Adsecute",
    detail: "Use Shopify where available and one matching rule for products with no cost.",
  },
];

const MEANING_OPTIONS: ReadonlyArray<{
  value: ShopifyUnitCostMeaning;
  label: string;
  detail: string;
}> = [
  {
    value: "unknown",
    label: "I’m not sure yet",
    detail: "You can keep reviewing, but the model cannot be confirmed until this is defined.",
  },
  {
    value: "product_purchase_only",
    label: "Supplier or manufacturing cost only",
    detail: "Shipping, duties, packaging, fees and other costs will be entered separately.",
  },
  {
    value: "landed_cost",
    label: "Product cost + inbound freight and duties",
    detail: "The Shopify value already includes getting the product into your inventory.",
  },
  {
    value: "loaded_variable_cost",
    label: "Product cost + all per-sale operating costs",
    detail: "The Shopify value combines product cost with the variable costs of making a sale.",
  },
  {
    value: "custom_composite",
    label: "I’ll choose exactly what is included",
    detail: "Use this when the Shopify value contains a custom mix of costs.",
  },
];

function defaultShopifyPolicy(): ShopifyUnitCostPolicy {
  return {
    meaning: "unknown",
    includedFamilies: ["product_purchase"],
    minimumCoveragePercent: 100,
    missingCostPolicy: "leave_unknown",
    fallbackComponentId: null,
    historicalPolicy: "unknown_before_first_observation",
  };
}

function familiesForMeaning(
  meaning: ShopifyUnitCostMeaning,
  current: readonly CostFamily[],
): CostFamily[] {
  if (meaning === "product_purchase_only") return ["product_purchase"];
  if (meaning === "landed_cost") {
    return ["product_purchase", "inbound_logistics", "duties_import"];
  }
  if (meaning === "loaded_variable_cost") return [...CONTRIBUTION_COST_FAMILIES];
  return [...new Set<CostFamily>(["product_purchase", ...current])];
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Never synced";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatMoney(amount: string | null, currencyCode: string | null) {
  if (amount === null || currencyCode === null) return "Missing";
  const value = Number(amount);
  if (!Number.isFinite(value)) return `${amount} ${currencyCode}`;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(value);
  } catch {
    return `${amount} ${currencyCode}`;
  }
}

export function ShopifyCostSourcePanel({
  businessId,
  structure,
  canEdit,
  saving,
  onChange,
  onCatalogSynced,
}: {
  businessId: string;
  structure: CommerceCostStructure;
  canEdit: boolean;
  saving: boolean;
  onChange: (structure: CommerceCostStructure) => void;
  onCatalogSynced?: () => void;
}) {
  const [catalog, setCatalog] = useState<CostCatalogResponse | null>(null);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [policyDetailsOpen, setPolicyDetailsOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        businessId,
        limit: "50",
        offset: String(offset),
      });
      if (appliedQuery) params.set("search", appliedQuery);
      const response = await fetch(
        `/api/business-commerce-cost-structure/shopify?${params.toString()}`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as CostCatalogResponse | null;
      if (!response.ok || !payload) {
        throw new Error(payload?.message ?? "Could not load Shopify product costs.");
      }
      setCatalog(payload);
      setError(null);
    } catch (loadError: unknown) {
      setError(
        loadError instanceof Error ? loadError.message : "Could not load Shopify product costs.",
      );
    } finally {
      setLoading(false);
    }
  }, [appliedQuery, businessId, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const response = await fetch("/api/business-commerce-cost-structure/shopify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId }),
      });
      const payload = (await response.json().catch(() => null)) as CostCatalogResponse | null;
      if (!response.ok || !payload) {
        throw new Error(payload?.message ?? "Shopify cost sync failed.");
      }
      setOffset(0);
      setAppliedQuery("");
      setQuery("");
      setCatalog(payload);
      onCatalogSynced?.();
    } catch (syncError: unknown) {
      setError(syncError instanceof Error ? syncError.message : "Shopify cost sync failed.");
    } finally {
      setSyncing(false);
    }
  };

  const summary = catalog?.summary;
  const rows = catalog?.rows ?? [];
  const matched = catalog?.matchedVariants ?? 0;
  const limit = catalog?.limit ?? 50;
  const currencies = useMemo(
    () =>
      (summary?.currencyCounts ?? [])
        .map((item) => `${item.currencyCode} · ${item.count}`)
        .join(", ") || "—",
    [summary?.currencyCounts],
  );
  const connected = Boolean(catalog?.connection?.connected);
  const ready = Boolean(catalog?.storage?.ready);
  const hasNext = offset + rows.length < matched;
  const sourcePolicy: CommerceCostSourcePolicy = structure.sourcePolicy ?? {
    productCostAuthority: "unconfigured",
  };
  const shopifyParticipates =
    sourcePolicy.productCostAuthority === "shopify_unit_cost" ||
    sourcePolicy.productCostAuthority === "hybrid";
  const shopifyPolicy = sourcePolicy.shopifyUnitCost ?? defaultShopifyPolicy();
  const activeProductComponents = structure.components.filter(
    (component) =>
      component.status === "active" &&
      component.family === "product_purchase" &&
      component.decisionClass !== "informational" &&
      component.evidence !== "override" &&
      component.source.kind !== "shopify_unit_cost",
  );
  const fallbackUnavailable =
    shopifyParticipates &&
    shopifyPolicy.missingCostPolicy === "manual_fallback" &&
    activeProductComponents.length === 0;
  const includedFamilyLabels = shopifyPolicy.includedFamilies
    .map((family) => costFamilyMeta(family).label)
    .join(", ");

  useEffect(() => {
    if (fallbackUnavailable) setPolicyDetailsOpen(true);
  }, [fallbackUnavailable]);
  const policyOverlapFamilies = useMemo(() => {
    if (!shopifyParticipates) return [];
    const fallbackId =
      shopifyPolicy.missingCostPolicy === "manual_fallback"
        ? shopifyPolicy.fallbackComponentId
        : null;
    return [...new Set(
      structure.components
        .filter(
          (component) =>
            component.status === "active" &&
            component.decisionClass !== "informational" &&
            component.id !== fallbackId &&
            [
              component.family,
              ...(component.embeds ?? []),
              ...(component.basis.kind === "margin_input"
                ? marginImpliedFamilies(component.basis.marginKind)
                : []),
            ].some((family) => shopifyPolicy.includedFamilies.includes(family)),
        )
        .flatMap((component) => [
          component.family,
          ...(component.embeds ?? []),
          ...(component.basis.kind === "margin_input"
            ? marginImpliedFamilies(component.basis.marginKind)
            : []),
        ])
        .filter((family) => shopifyPolicy.includedFamilies.includes(family)),
    )];
  }, [shopifyParticipates, shopifyPolicy, structure.components]);

  const updateSourcePolicy = (next: CommerceCostSourcePolicy) => {
    onChange({
      ...structure,
      origin: "operator",
      confirmed: false,
      sourcePolicy: next,
    });
  };

  const setAuthority = (authority: ProductCostAuthority) => {
    updateSourcePolicy({
      productCostAuthority: authority,
      ...((authority === "shopify_unit_cost" || authority === "hybrid")
        ? { shopifyUnitCost: sourcePolicy.shopifyUnitCost ?? defaultShopifyPolicy() }
        : {}),
    });
  };

  const updateShopifyPolicy = (patch: Partial<ShopifyUnitCostPolicy>) => {
    const current = sourcePolicy.shopifyUnitCost ?? defaultShopifyPolicy();
    updateSourcePolicy({
      ...sourcePolicy,
      productCostAuthority:
        sourcePolicy.productCostAuthority === "hybrid" ? "hybrid" : "shopify_unit_cost",
      shopifyUnitCost: { ...current, ...patch },
    });
  };

  const setMeaning = (meaning: ShopifyUnitCostMeaning) => {
    updateShopifyPolicy({
      meaning,
      includedFamilies: familiesForMeaning(meaning, shopifyPolicy.includedFamilies),
    });
  };

  const toggleIncludedFamily = (family: CostFamily) => {
    if (family === "product_purchase") return;
    const included = shopifyPolicy.includedFamilies.includes(family)
      ? shopifyPolicy.includedFamilies.filter((candidate) => candidate !== family)
      : [...shopifyPolicy.includedFamilies, family];
    updateShopifyPolicy({
      meaning: "custom_composite",
      includedFamilies: [...new Set<CostFamily>(["product_purchase", ...included])],
    });
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setOffset(0);
    setAppliedQuery(query.trim());
  };

  return (
    <article className={styles.shell} data-testid="shopify-cost-source-panel">
      <header className={styles.header}>
        <div>
          <div className={styles.kickerRow}>
            <span className={styles.kicker}>SOURCE COSTS</span>
            <span className={connected ? styles.connected : styles.disconnected}>
              {connected ? "Shopify connected" : "Shopify not connected"}
            </span>
          </div>
          <h2>Shopify product costs</h2>
          <p>
            Current variant unit costs from Shopify. These rows are source evidence and are not
            used by Overview, Meta, Google or decision automation yet.
          </p>
        </div>
        <button
          type="button"
          className={styles.syncButton}
          onClick={() => void sync()}
          disabled={!canEdit || !connected || !catalog?.connection?.scopeReady || !ready || syncing}
        >
          <RefreshCw size={15} className={syncing ? styles.spin : undefined} aria-hidden="true" />
          {syncing ? "Syncing catalog…" : "Sync from Shopify"}
        </button>
      </header>

      <section className={styles.policySection} aria-labelledby="cost-source-policy-title">
        <div className={styles.policyHeader}>
          <div>
            <span className={styles.step}>1 · SOURCE AUTHORITY</span>
          <h3 id="cost-source-policy-title">How does this business define product cost?</h3>
          <p>
              Choose the source you actually maintain. Adsecute uses the answer to prevent the
              same cost from being counted twice.
          </p>
          </div>
          <span className={styles.sharedSaveNote}>Saved with the cost model below</span>
        </div>

        <ol className={styles.setupGuide} aria-label="Product cost setup steps">
          <li><span>1</span><strong>Choose where product cost comes from</strong></li>
          <li><span>2</span><strong>Tell us what that number includes</strong></li>
          <li><span>3</span><strong>Add only the costs still missing</strong></li>
        </ol>

        <div className={styles.authorityGrid} role="radiogroup" aria-label="Product cost authority">
          {AUTHORITY_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={
                sourcePolicy.productCostAuthority === option.value
                  ? styles.authoritySelected
                  : styles.authorityOption
              }
            >
              <input
                type="radio"
                name="product-cost-authority"
                value={option.value}
                checked={sourcePolicy.productCostAuthority === option.value}
                onChange={() => setAuthority(option.value)}
                disabled={!canEdit || saving}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
            </label>
          ))}
        </div>

        {shopifyParticipates ? (
          <div className={styles.shopifyPolicy}>
            <div className={styles.primaryPolicyField}>
              <div className={styles.fieldHeading}>
                <label htmlFor="shopify-cost-meaning">
                  What is included in Shopify “Cost per item”?
                </label>
                <FieldHelpTip label="Shopify Cost per item">
                  This is the value stored on each Shopify product or variant. It is different from
                  a store-wide expense ratio or profit margin.
                </FieldHelpTip>
              </div>
              <select
                id="shopify-cost-meaning"
                value={shopifyPolicy.meaning}
                onChange={(event) => setMeaning(event.target.value as ShopifyUnitCostMeaning)}
                disabled={!canEdit || saving}
              >
                {MEANING_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <small>
                {MEANING_OPTIONS.find((option) => option.value === shopifyPolicy.meaning)?.detail}
              </small>
            </div>

            {shopifyPolicy.meaning === "custom_composite" ? (
              <fieldset className={styles.composition}>
                <legend id="shopify-included-costs">Select what is already inside the Shopify value</legend>
                <p>
                  Do not add checked costs again below. Product purchase remains required because
                  this field describes Shopify product cost.
                </p>
                <div className={styles.familyGrid}>
                  {CONTRIBUTION_COST_FAMILIES.map((family) => (
                    <label key={family}>
                      <input
                        type="checkbox"
                        checked={shopifyPolicy.includedFamilies.includes(family)}
                        onChange={() => toggleIncludedFamily(family)}
                        disabled={!canEdit || saving || family === "product_purchase"}
                      />
                      <span>{costFamilyMeta(family).label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : (
              <div className={styles.includedSummary} data-state={shopifyPolicy.meaning === "unknown" ? "review" : "ready"}>
                {shopifyPolicy.meaning === "unknown"
                  ? <AlertTriangle size={16} aria-hidden="true" />
                  : <CheckCircle2 size={16} aria-hidden="true" />}
                <span>
                  <strong>{shopifyPolicy.meaning === "unknown" ? "One answer still needed" : "Adsecute will treat these costs as included"}</strong>
                  <small>{shopifyPolicy.meaning === "unknown" ? "Choose what Shopify Cost per item means above." : includedFamilyLabels}</small>
                </span>
              </div>
            )}

            <button
              type="button"
              className={styles.policyDetailsToggle}
              aria-expanded={policyDetailsOpen}
              aria-controls="shopify-policy-details"
              onClick={() => setPolicyDetailsOpen((current) => !current)}
            >
              <span>
                <strong>Coverage and older orders</strong>
                <small>
                  {summary?.coveragePercent == null ? "Catalog coverage not loaded" : `${summary.coveragePercent.toFixed(1)}% of variants currently have cost`}
                </small>
              </span>
              {policyDetailsOpen ? <ChevronUp size={17} aria-hidden="true" /> : <ChevronDown size={17} aria-hidden="true" />}
            </button>

            {policyDetailsOpen ? (
              <div id="shopify-policy-details" className={styles.policyDetails}>
                <div className={styles.policyFields}>
                  <div className={styles.fieldBlock}>
                    <div className={styles.fieldHeading}>
                      <label htmlFor="shopify-minimum-coverage">Required cost coverage</label>
                      <FieldHelpTip label="required cost coverage">
                        The model stays in review when fewer than this percentage of Shopify
                        variants have a cost. Use 100% when every product must be covered.
                      </FieldHelpTip>
                    </div>
                    <div className={styles.percentInput}>
                      <input
                        id="shopify-minimum-coverage"
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={shopifyPolicy.minimumCoveragePercent}
                        onChange={(event) =>
                          updateShopifyPolicy({ minimumCoveragePercent: Number(event.target.value) })
                        }
                        disabled={!canEdit || saving}
                      />
                      <span>%</span>
                    </div>
                    <small>This is a readiness rule; it does not invent missing cost.</small>
                  </div>

                  <div className={styles.fieldBlock}>
                    <div className={styles.fieldHeading}>
                      <label htmlFor="shopify-missing-cost-policy">Products with no Shopify cost</label>
                      <FieldHelpTip label="products with no Shopify cost">
                        “Keep unknown” is safest. Choose a fallback only when you have created a
                        matching product-cost rule below.
                      </FieldHelpTip>
                    </div>
                    <select
                      id="shopify-missing-cost-policy"
                      value={shopifyPolicy.missingCostPolicy}
                      onChange={(event) => {
                        const missingCostPolicy = event.target.value as ShopifyUnitCostPolicy["missingCostPolicy"];
                        updateShopifyPolicy({
                          missingCostPolicy,
                          fallbackComponentId:
                            missingCostPolicy === "manual_fallback"
                              ? shopifyPolicy.fallbackComponentId ?? activeProductComponents[0]?.id ?? null
                              : null,
                        });
                      }}
                      disabled={!canEdit || saving}
                    >
                      <option value="leave_unknown">Keep their cost unknown</option>
                      <option value="manual_fallback">Use an Adsecute fallback rule</option>
                    </select>
                    <small>A missing cost is never treated as zero.</small>
                  </div>

                  <div className={`${styles.fieldBlock} ${styles.fullField}`}>
                    <div className={styles.fieldHeading}>
                      <label htmlFor="shopify-historical-policy">Orders from before cost tracking began</label>
                      <FieldHelpTip label="older Shopify orders">
                        Shopify provides the current catalog cost, not proof of the cost on an older
                        order date. Keep it unknown unless you have dated cost rules.
                      </FieldHelpTip>
                    </div>
                    <select
                      id="shopify-historical-policy"
                      value={shopifyPolicy.historicalPolicy}
                      onChange={(event) =>
                        updateShopifyPolicy({
                          historicalPolicy: event.target.value as ShopifyUnitCostPolicy["historicalPolicy"],
                        })
                      }
                      disabled={!canEdit || saving}
                    >
                      <option value="unknown_before_first_observation">Keep older order cost unknown</option>
                      <option value="manual_components_before_first_observation">Use dated Adsecute cost rules</option>
                    </select>
                    <small>Use dated rules only when you can support the older amount.</small>
                  </div>
                </div>

                {shopifyPolicy.missingCostPolicy === "manual_fallback" ? (
                  <div className={styles.fallbackField}>
                    <div className={styles.fieldHeading}>
                      <label htmlFor="shopify-fallback-component">Fallback product-cost rule</label>
                      <FieldHelpTip label="fallback product-cost rule">
                        This rule is used only for variants whose Shopify Cost per item is missing.
                        Its included costs must match the Shopify definition above.
                      </FieldHelpTip>
                    </div>
                    <select
                      id="shopify-fallback-component"
                      value={shopifyPolicy.fallbackComponentId ?? ""}
                      onChange={(event) =>
                        updateShopifyPolicy({ fallbackComponentId: event.target.value || null })
                      }
                      disabled={!canEdit || saving || activeProductComponents.length === 0}
                    >
                      <option value="">Choose a product-cost rule</option>
                      {activeProductComponents.map((component) => (
                        <option key={component.id} value={component.id}>
                          {component.label ?? component.id}
                        </option>
                      ))}
                    </select>
                    <small>
                      {activeProductComponents.length === 0
                        ? "No eligible product-cost rule exists in the model below."
                        : "This rule applies only where Shopify has no unit cost."}
                    </small>
                  </div>
                ) : null}

                {fallbackUnavailable ? (
                  <div className={styles.fallbackAlert} role="alert">
                    <AlertTriangle size={17} aria-hidden="true" />
                    <div>
                      <strong>Fallback cannot be used yet</strong>
                      <span>
                        {summary?.missingCostVariants === 0
                          ? `All ${summary.costedVariants?.toLocaleString("en-US") ?? "observed"} variants currently have a cost, so no fallback is needed.`
                          : "Create a matching product-cost rule below, or keep missing product costs unknown for now."}
                      </span>
                      <button
                        type="button"
                        onClick={() => updateShopifyPolicy({ missingCostPolicy: "leave_unknown", fallbackComponentId: null })}
                        disabled={!canEdit || saving}
                      >
                        Keep missing costs unknown
                      </button>
                    </div>
                  </div>
                ) : shopifyPolicy.missingCostPolicy === "leave_unknown" && summary?.missingCostVariants === 0 ? (
                  <div className={styles.validNote} role="status">
                    <CheckCircle2 size={16} aria-hidden="true" />
                    No Shopify product-cost gaps are present, so a fallback is not needed now.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : sourcePolicy.productCostAuthority === "manual_components" ? (
          <div className={styles.manualNote}>
            <strong>Manual model owns product cost.</strong>
            <span>
              The editor below supports store-wide revenue percentages, unit costs, gross or
              contribution margins, BOMs, per-order rates and scoped supplier, market or channel
              costs. Shopify remains visible as reference evidence only.
            </span>
          </div>
        ) : (
          <div className={styles.manualNote}>
            <strong>Choose a source authority.</strong>
            <span>No source will be silently preferred while this is unconfigured.</span>
          </div>
        )}

        <div className={styles.readinessGrid}>
          <div data-state={sourcePolicy.productCostAuthority === "unconfigured" ? "review" : "ready"}>
            {sourcePolicy.productCostAuthority === "unconfigured" ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
            <span><strong>Authority</strong><small>{sourcePolicy.productCostAuthority === "unconfigured" ? "Not selected" : "Explicitly selected"}</small></span>
          </div>
          <div data-state={sourcePolicy.productCostAuthority === "unconfigured" || (shopifyParticipates && shopifyPolicy.meaning === "unknown") ? "review" : "ready"}>
            {sourcePolicy.productCostAuthority === "unconfigured" || (shopifyParticipates && shopifyPolicy.meaning === "unknown") ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
            <span><strong>Meaning</strong><small>{sourcePolicy.productCostAuthority === "unconfigured" ? "Waiting for authority" : !shopifyParticipates ? "Defined by manual components" : shopifyPolicy.meaning === "unknown" ? "Review what unit cost includes" : "Composition declared"}</small></span>
          </div>
          <div data-state={!shopifyParticipates || (summary?.coveragePercent ?? -1) >= shopifyPolicy.minimumCoveragePercent ? "ready" : "review"}>
            {!shopifyParticipates || (summary?.coveragePercent ?? -1) >= shopifyPolicy.minimumCoveragePercent ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
            <span><strong>Coverage</strong><small>{!shopifyParticipates ? "Not dependent on Shopify" : summary?.coveragePercent == null ? "No catalog snapshot" : `${summary.coveragePercent.toFixed(1)}% observed · ${shopifyPolicy.minimumCoveragePercent}% required`}</small></span>
          </div>
          <div data-state={policyOverlapFamilies.length === 0 ? "ready" : "blocked"}>
            {policyOverlapFamilies.length === 0 ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
            <span><strong>Double counting</strong><small>{policyOverlapFamilies.length === 0 ? "No overlapping owner found" : `${policyOverlapFamilies.map((family) => costFamilyMeta(family).label).join(", ")} also configured directly`}</small></span>
          </div>
        </div>
      </section>

      <div className={styles.guardrail} role="note">
        <AlertTriangle size={16} aria-hidden="true" />
        <span>
          Shopify exposes the current catalog cost, not the exact cost at the time of an older
          order. Edit source values in Shopify. The setup above records their meaning and
          precedence, but remains disconnected from Overview and decision automation.
        </span>
      </div>

      {!ready ? (
        <div className={styles.error} role="alert">
          Shopify cost storage is not ready. Missing: {catalog?.storage?.missingTables?.join(", ") || "unknown"}.
        </div>
      ) : null}
      {connected && !catalog?.connection?.scopeReady ? (
        <div className={styles.error} role="alert">
          Reconnect Shopify with: {catalog?.connection?.missingScopes?.join(", ")}.
        </div>
      ) : null}
      {error ? <div className={styles.error} role="alert">{error}</div> : null}

      <div className={styles.stats}>
        <div>
          <span>Catalog variants</span>
          <strong>{summary?.totalVariants?.toLocaleString("en-US") ?? "—"}</strong>
        </div>
        <div>
          <span>Cost coverage</span>
          <strong>
            {summary?.coveragePercent == null ? "—" : `${summary.coveragePercent.toFixed(1)}%`}
          </strong>
          <small>
            {summary
              ? `${summary.costedVariants ?? 0} costed · ${summary.missingCostVariants ?? 0} missing`
              : "No catalog snapshot"}
          </small>
        </div>
        <div>
          <span>Currencies</span>
          <strong className={styles.currencyList}>{currencies}</strong>
        </div>
        <div>
          <span>Last observed</span>
          <strong className={styles.date}>{formatDate(summary?.lastSyncedAt)}</strong>
          {catalog?.connection?.shopDomain ? <small>{catalog.connection.shopDomain}</small> : null}
        </div>
      </div>

      <button
        type="button"
        className={styles.catalogToggle}
        onClick={() => setCatalogOpen((current) => !current)}
        aria-expanded={catalogOpen}
        aria-controls="shopify-product-catalog"
      >
        <span>
          <strong>Products and variants</strong>
          <small>
            {matched.toLocaleString("en-US")} matching rows · Open only when you need row-level details
          </small>
        </span>
        {catalogOpen ? (
          <ChevronUp size={18} aria-hidden="true" />
        ) : (
          <ChevronDown size={18} aria-hidden="true" />
        )}
      </button>

      {catalogOpen ? (
        <section id="shopify-product-catalog" className={styles.catalogPanel}>
          <div className={styles.tableToolbar}>
            <div>
              <strong>Variant catalog</strong>
              <span>{matched.toLocaleString("en-US")} matching rows</span>
            </div>
            <form onSubmit={submitSearch} className={styles.searchForm}>
              <Search size={14} aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search product, variant or SKU"
                aria-label="Search Shopify product costs"
              />
              <button type="submit">Search</button>
            </form>
          </div>

          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Variant</th>
                  <th>SKU</th>
                  <th>Shopify unit cost</th>
                  <th>Source status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className={styles.empty}>Loading Shopify costs…</td></tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className={styles.empty}>
                      {summary?.lastSyncedAt
                        ? "No variants match this search."
                        : "No Shopify cost snapshot yet. Sync the catalog to see source coverage."}
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.variantId}>
                      <td><strong>{row.productTitle ?? "Untitled product"}</strong></td>
                      <td>{row.variantTitle ?? "Default variant"}</td>
                      <td className={styles.mono}>{row.sku ?? "—"}</td>
                      <td className={row.unitCost === null ? styles.missing : styles.amount}>
                        {formatMoney(row.unitCost, row.currencyCode)}
                      </td>
                      <td>
                        {row.unitCost === null ? (
                          <span className={styles.missingBadge}><AlertTriangle size={12} /> Missing</span>
                        ) : (
                          <span className={styles.readyBadge}><CheckCircle2 size={12} /> Observed</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <footer className={styles.footer}>
            <span>
              {matched === 0 ? "0 rows" : `${offset + 1}–${Math.min(offset + rows.length, matched)} of ${matched}`}
            </span>
            <div>
              <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - limit))}>
                Previous
              </button>
              <button type="button" disabled={!hasNext || loading} onClick={() => setOffset(offset + limit)}>
                Next
              </button>
            </div>
          </footer>
        </section>
      ) : null}
    </article>
  );
}

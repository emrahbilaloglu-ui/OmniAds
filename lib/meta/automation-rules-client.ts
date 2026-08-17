/**
 * Browser-side calls for the two rule mutations the design exposes: the Active
 * toggle and "+ New rule".
 *
 * Both go to the existing `/api/meta/automation` handler, which is where the
 * authorization chain already lives — session, `requireBusinessAccess`,
 * assigned-account scope, reviewer read-only. There is deliberately no second
 * endpoint and no provider call anywhere in this file; a rule mutation only
 * ever edits a row in this product's own database.
 *
 * Kept out of the surface component for the same reason `history-client.ts` is:
 * the exact view renders a view model and nothing else.
 */

import type { MetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";
import type {
  AutomationRuleAction,
  AutomationRuleEntityLevel,
  AutomationRuleMode,
  AutomationRuleTrigger,
} from "@/lib/meta/automation-rules";

type FetchLike = typeof fetch;

export interface AutomationRuleDraftInput {
  name: string;
  entityLevel: AutomationRuleEntityLevel;
  trigger: AutomationRuleTrigger;
  action: AutomationRuleAction;
  mode: AutomationRuleMode;
}

async function postAutomationAction(input: {
  businessId: string;
  providerAccountId: string | null;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<MetaAutomationControlPlane> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const params = new URLSearchParams({ businessId: input.businessId });
  if (input.providerAccountId) {
    params.set("providerAccountId", input.providerAccountId);
  }
  const response = await fetchImpl(
    `/api/meta/automation?${params.toString()}`,
    {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.body),
      signal: input.signal,
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    automation?: MetaAutomationControlPlane;
    error?: { code?: string; message?: string };
  } | null;
  if (!response.ok || payload?.ok === false || !payload?.automation) {
    throw new Error(
      payload?.error?.message ?? "Automation rule change was not applied.",
    );
  }
  return payload.automation;
}

export function setAutomationRuleActiveRequest(input: {
  businessId: string;
  providerAccountId: string | null;
  ruleId: string;
  active: boolean;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}) {
  return postAutomationAction({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    signal: input.signal,
    fetchImpl: input.fetchImpl,
    body: {
      action: "set_rule_active",
      ruleId: input.ruleId,
      active: input.active,
    },
  });
}

export function createAutomationRuleRequest(input: {
  businessId: string;
  providerAccountId: string | null;
  rule: AutomationRuleDraftInput;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}) {
  return postAutomationAction({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    signal: input.signal,
    fetchImpl: input.fetchImpl,
    body: { action: "create_rule", rule: input.rule },
  });
}

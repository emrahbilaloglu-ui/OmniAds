/** Copy classification only. These holds withhold authority, not the economic
 * calculation. Unknown codes remain evidence gaps; this never grants a write. */
const ROLE_AUTHORITY_HOLDS = new Set([
  "campaign_context", "campaign_context_unresolved", "campaign_context_conflict",
  "campaign_context_low_confidence", "campaign_context_resolver_unvalidated",
  "campaign_role_unresolved", "campaign_label_missing", "unlabeled_campaign_context",
  "adset_role_unresolved", "role_authority_absent", "role_authority_unresolved",
  "role_authority_not_automatic", "role_authority_declared_unbound",
]);

export function isRoleAuthorityHold(code: string): boolean {
  return ROLE_AUTHORITY_HOLDS.has(code);
}

export function isNonEconomicAuthorityHold(code: string): boolean {
  return code === "config_source_authority" || code === "pending_transition" ||
    isRoleAuthorityHold(code);
}

export const META_EXECUTION_SUPPORTED_ACTIONS = [
  "pause",
  "recover",
  "scale_budget",
  "reduce_budget",
] as const;

export type MetaExecutionSupportedAction =
  (typeof META_EXECUTION_SUPPORTED_ACTIONS)[number];

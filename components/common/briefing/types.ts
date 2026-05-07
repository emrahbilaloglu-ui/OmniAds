export type DecisionLevel = "creative" | "campaign" | "adset" | "account";

export type DecisionLabel =
  | "scale"
  | "cut"
  | "refresh"
  | "keep"
  | "test_more"
  | "diagnose"
  | "below_breakeven"
  | "fatigue"
  | "rebuild"
  | "switch"
  | "tune"
  | "swap"
  | "review_placements"
  | "review_adsets"
  | "out_of_scope";

export type LaneKey = "action" | "watching" | "healthy" | "audience";

export type ConfidenceTier = "high" | "mid" | "low";

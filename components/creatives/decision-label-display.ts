import type { DecisionLabel } from "@/lib/creative-decision-engine";
import {
  CREATIVE_ENGINE_DECISION_LABELS,
  DECISION_LABEL_PALETTE,
  TONE_CLASS as BRIEFING_TONE_CLASS,
  type BriefingLabelTone,
} from "@/components/common/briefing/decision-label-palette";

export type LabelTone = BriefingLabelTone;

export const DECISION_LABELS: DecisionLabel[] = [...CREATIVE_ENGINE_DECISION_LABELS];

export const LABEL_DISPLAY: Record<
  DecisionLabel,
  { label: string; tone: LabelTone }
> = {
  scale: {
    label: DECISION_LABEL_PALETTE.scale.label,
    tone: DECISION_LABEL_PALETTE.scale.tone,
  },
  keep: {
    label: DECISION_LABEL_PALETTE.keep.label,
    tone: DECISION_LABEL_PALETTE.keep.tone,
  },
  refresh: {
    label: DECISION_LABEL_PALETTE.refresh.label,
    tone: DECISION_LABEL_PALETTE.refresh.tone,
  },
  cut: {
    label: DECISION_LABEL_PALETTE.cut.label,
    tone: DECISION_LABEL_PALETTE.cut.tone,
  },
  test_more: {
    label: DECISION_LABEL_PALETTE.test_more.label,
    tone: DECISION_LABEL_PALETTE.test_more.tone,
  },
  diagnose: {
    label: DECISION_LABEL_PALETTE.diagnose.label,
    tone: DECISION_LABEL_PALETTE.diagnose.tone,
  },
  out_of_scope: {
    label: DECISION_LABEL_PALETTE.out_of_scope.label,
    tone: DECISION_LABEL_PALETTE.out_of_scope.tone,
  },
};

export const TONE_CLASS = BRIEFING_TONE_CLASS;

// Adsecute canonical flow / matrix / glossary / mobile / print-share contracts v3.1 — the
// single source the computed gates REQ-33..37 verify the rendered artifacts against.
// Nothing here is a verdict: each row names what must exist in the rendered DOM (anchors,
// frames, branch kinds); the gate computer compares and fails closed on any miss.

// 13 required flows (artifact 03). kinds = branch-chip kinds that MUST appear in that flow's
// rendered steps; els = [data-el] anchors that must resolve inside the flow's section.
export const FLOWS=[
{id:"Flow A",title:"Honest agency entry",minSteps:4,kinds:["perm"],els:["flow-a-direction-enter","flow-a-direction-return"]},
{id:"Flow B",title:"Meta decision to supported action",minSteps:5,kinds:["err","conf"],els:[]},
{id:"Flow C",title:"Needs Resolution",minSteps:4,kinds:["unav"],els:[]},
{id:"Flow D",title:"Creative refresh",minSteps:4,kinds:["blk"],els:[]},
{id:"Flow E",title:"Meta launch preparation",minSteps:4,kinds:["blk"],els:[]},
{id:"Flow F",title:"Google manual plan & default-off writes",minSteps:4,kinds:["conf"],els:[]},
{id:"Flow G",title:"Report delivery",minSteps:4,kinds:["safe"],els:[]},
{id:"Flow H",title:"Integration recovery",minSteps:4,kinds:["safe"],els:[]},
{id:"Flow I",title:"Meta automation safety",minSteps:4,kinds:["perm"],els:[]},
{id:"Flow J",title:"Admin incident response",minSteps:4,kinds:["err"],els:[]},
{id:"Flow K",title:"Onboarding & invite",minSteps:4,kinds:["blk"],els:[]},
{id:"Flow L",title:"Share lifecycle",minSteps:4,kinds:["safe"],els:[]},
{id:"Flow M",title:"Account & business lifecycle",minSteps:3,kinds:["unav"],els:[]}
];
export function flowIds(){ return FLOWS.map(f=>f.id); }

// 9 required state matrices (artifact 04) — rendered as data-screen-label sections M1..M9.
export const MATRICES=[
{id:"M1",t:"Authentication & identity"},{id:"M2",t:"Plan intent vs real authorization"},
{id:"M3",t:"Business / provider / account assignment & currency-timezone proof"},
{id:"M4",t:"Data states"},{id:"M5",t:"Meta decision & workflow"},{id:"M6",t:"Creative Engine V3 posture"},
{id:"M7",t:"Mutation lifecycle"},{id:"M8",t:"Shares"},{id:"M9",t:"Responsive & delivery targets"}
];
export function matrixIds(){ return MATRICES.map(m=>m.id); }

// Glossary / localization coverage (artifact 17 §3) — each token must resolve as a rendered
// [data-gloss] anchor. Categories: the verbatim-localization rule, the non-translatable
// identifier list, replay vocabulary, the legacy-term mapping, lane + bucket vocabularies,
// and the write-ceremony vocabulary.
export const GLOSS_REQUIRED=["localization-verbatim","non-translatable","replay","legacy-mapping","lanes","google-buckets","write-ceremony"];

// Mobile Agency / scope completion (artifact 14) — REQ-37. Every entry is [el, frame]:
// the [data-el] anchor must resolve inside that exact rendered frame.
export const MOBILE_REQUIRED={
sheetFrames:["H63","H64"], // open MOBILE-02 scope sheet drawn at 390 AND 320
scopeFields:["context","business","provider","account","currency","timezone","window","freshness"],
els:[["agency-return","H60"],["agency-return","H61"],["agency-return","H66"],
["switch-eligible","H65"],["switch-denied","H65"],["switch-loading","H65"],["switch-empty","H65"],["switch-error","H65"],
["flow-a-direction-enter","H51"],["flow-a-direction-return","H66"],
["win-320","H55"]]
};

// Print/PDF + public-share responsive coverage — REQ-36. [el, frame] pairs.
export const PRINT_SHARE_REQUIRED=[["print-view","H39"],["public-share","H49"],["public-share","H54"],["public-share","H59"]];

// Adversarial review scopes — REQ-42 requires one dated provenance-only review per scope.
export const REVIEW_SCOPES=[
{id:"SR-1",scope:"expert media-buyer review"},{id:"SR-2",scope:"trust & safety review"},
{id:"SR-3",scope:"capability & route completeness"},{id:"SR-4",scope:"list-truncation sweep"},
{id:"SR-5",scope:"UI-computed decision-fact sweep"},{id:"SR-6",scope:"money-sum proof sweep"}];

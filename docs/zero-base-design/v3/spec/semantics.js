// Adsecute component semantics v3 — the semantic implementation + QA matrix for every drawn
// control type, plus the contract→component mapping and the verification-label vocabulary.
// The design canvas is a STATIC specification, not production DOM: every behavior row here is
// "specified-for-implementation". What "prototype-tested" may label is only what the rendered
// audit actually measures on the drawn artboards (geometry, contrast, text floors, disclosure
// presence, reflow at the drawn widths). Nothing else may claim runtime verification.
export const VERIFICATION_LABELS={
"prototype-tested":"measured on the rendered artifact by the v3 audit: target boxes, artboard geometry/overflow, computed text + non-text contrast, text-role floors, collection disclosures, control/contract equality",
"specified-for-implementation":"defined here for the application build; not executable in a static design canvas — verified at implementation stage (see IMPLEMENTATION_GATES)"};
const S=(component,native,role,name,states,keyboard,focus,errors,responsive)=>({component,native,role,name,states,keyboard,focus,errors,responsive,verification:"specified-for-implementation"});
export const COMPONENTS=[
S("Button (primary/secondary/danger)","<button>","button (implicit)","visible label; icon-only forbidden except toolbar icons with title+aria-label","rest · hover · focus · active · disabled-with-reason (aria-disabled + describedby)","Enter/Space activate","2px accent ring, offset 2; never removed","action failure renders verbatim server error near the button; button re-enables","≥24×24 always; ≥44×44 when [data-primary] on mobile frames"),
S("Icon button (nudge, close, menu ⋯)","<button>","button","aria-label names exact action ('Move left one column')","rest · focus · disabled at bound (aria-disabled + 'edge reached' announced)","Enter/Space","ring as Button","bound hit announces via role=status","24px minimum; 44px in mobile toolbars"),
S("Row button (decision/list rows)","<button> or <a> filling the row","button/link","row title + verdict summary as accessible name","rest · hover · focus · selected(current in URL)","Enter opens inspector; ↑↓ roving between rows","ring on row boundary","row gone on refresh → inspector notes 'row no longer served'","columns fold per P2/P3; min row target 24px, 44px mobile"),
S("Link action (Open · Edit · Duplicate)","<a href> or <button>","link/button","verb + object ('Edit Monthly performance')","rest · focus · visited n/a","Enter","ring","dead targets never rendered (absence over theatre)","inline-flex hit box ≥24px both axes"),
S("Menu button + menu","<button aria-haspopup=menu> + <ul role=menu>","menu/menuitem","button labels the set; items label actions","closed · open · item-focused · item-disabled-with-reason","Enter/Space/↓ open; ↑↓ rove; type-ahead; Esc closes to trigger","trap within open menu; return to trigger","failed action → menu closes, error verbatim at origin row","menus become bottom sheets <768"),
S("Tabs","<div role=tablist> + <button role=tab> + panels","tablist/tab/tabpanel","tab text; aria-selected","selected · unselected · unavailable renders truth-state panel (tab never hidden)","←→ rove; Home/End; panel reachable by Tab","ring on tab; 2px underline is selection, not focus","—","overflow scrolls with fade + arrows; sheet on mobile"),
S("Segmented / radio group (scope, lanes, tiers)","<fieldset> + <input type=radio>","radiogroup/radio","group label + option labels; counts read as text","checked · unchecked · disabled-with-reason","↑↓←→ move selection; Space checks","ring on focused option","—","wraps to rows; 24px targets, 44px mobile"),
S("Checkbox (assignment, ack, mark-applied)","<input type=checkbox> in <label>","checkbox","full-row label is the target","checked · unchecked · disabled-with-reason · error","Space toggles","ring on box + label row","journal/save failure reverts the box + verbatim error","row target ≥24px; ≥44px mobile"),
S("Text input (auth, settings, economics)","<input>/<textarea> + <label>","textbox","visible label above; never placeholder-as-label","rest · focus · invalid (aria-invalid + describedby) · disabled-with-reason","standard editing; Enter submits single-field forms only","ring; error does not steal focus","inline error text + icon on blur; server errors verbatim, value kept","44px height mobile; numeric right-aligned mono"),
S("Combobox (business switcher, account/property/site pickers)","<input role=combobox> + listbox popup","combobox/listbox/option","labelled by its scope ('Business'); selection announced","closed · open · filtered · empty ('no matches' + clear) · saving · saved(read-back)","APG combobox: type-ahead, ↑↓, Enter selects, Esc closes","trap in popup; return to input","assignment failure verbatim; nothing partially claimed","full-screen sheet <768"),
S("Global search overlay","dialog + combobox + grouped listbox","dialog/listbox","'Businesses + Meta entities' label verbatim","open · loading · results · truncated(disclosure line) · permission-empty","/ opens; ↑↓ rove groups; Enter opens; Esc closes","trap; return to trigger","—","full-screen <768"),
S("Nav rail / drawer item","<nav> + <a aria-current=page>","navigation/link","item text; group headers are presentation","rest · active(aria-current) · badge text read inline","↑↓ move; Enter opens; skip-link precedes rail","ring inside rail; drawer traps focus, Esc closes to hamburger","unavailable modules absent, never disabled-teasers","rail 232px ≥1024; scrimmed drawer below; items 44px in drawer; rail nav area scrolls when viewport is short — footer identity row never clipped"),
S("Inspector / sheet (drawer)","<aside role=dialog aria-modal>","dialog","titled by row name","open · loading · row-gone note","trap; Esc closes; focus returns to originating row","initial focus on title; 2.4.11 clearance under sticky header","per-section errors inline","480px drawer ≥1280; full-height sheet ≤768"),
S("Dialog (confirm / destructive)","<dialog> or role=dialog aria-modal","dialog","title states the action; body restates scope + before→after","open · typed-confirm-incomplete(submit disabled with reason) · submitting · failed(verbatim)","trap; Esc cancels; Enter submits only when typed confirm complete","initial focus on Cancel (least destructive)","failure keeps dialog + verbatim error; nothing mutated","max 440px; full-width sheet on mobile"),
S("Selectable card (report widget)","<button aria-pressed> wrapping card OR grid cell with aria-selected","button + application grid pattern","widget title + position ('Spend — row 1, col 1, 1×1')","unselected · selected(toolbar + caption attach) · error(retry) · empty","Enter/Space select; arrows move 1 cell; Shift+arrows resize; Esc cancel-revert; Ctrl/Cmd+Z undo (50)","2px ring distinct from selection border","widget failure → per-widget error+retry; page never blanks","grid 3 cols ≥1280 · 3 at 1280 · 2 at 768; nudge buttons 44px mobile"),
S("Dot pagination (carousel)","<button> per dot in a group labelled 'slide position'","button group","'card N of M'","current · other","←→ when focused; Enter activates","ring around 24px hit box","—","24px targets all widths"),
S("Chart/table toggle","<button aria-pressed>","button","'View as table' / 'View as chart'","chart · table (real <table> markup swapped in place)","Enter/Space","ring","—","preference persisted per surface"),
S("Load more / cursor pagination","<button>","button","'Load N more' with X-of-Y restated adjacent","rest · loading · end('all Y shown', control disabled or replaced)","Enter/Space","ring; focus stays on control; new count announced","end of projection disables with reason","44px mobile"),
S("Media play / retry","<button>","button","'Play — {creative name}' / 'Retry'","poster · playing · failed(verbatim code)","Enter/Space toggle","ring","stream error → poster + verbatim error + retry","44px on share pages"),
S("Status / live region","<div role=status aria-live=polite>","status","—","announces: preflight age refresh, submit progress, outcomes, copied, result counts, nudge positions","—","never focused programmatically except outcome titles","—","—"),
S("Scope sheet trigger (mobile header)","<button>","button","business + account + window + currency + timezone + freshness as its accessible name","rest · open(sheet)","Enter/Space; sheet traps; Esc/swipe closes","ring; return to trigger","—","44px; two-line ellipsized header, full values in sheet"),
S("Disabled control with reason","<button aria-disabled=true aria-describedby=reason>","button","label + reason id","non-interactive; reason always rendered inline (never tooltip-only)","focusable for discovery; activation no-ops","ring allowed (discoverable)","—","reason wraps, never truncates")
];
// contract key → component (ordered first-match); explicit overrides first
const MAP=[
[/^live:cancel|^live:done|^live:close$/, "Dialog (confirm / destructive)"],
[/nav-drawer/, "Nav rail / drawer item"],
[/^live:nav$/, "Nav rail / drawer item"],
[/^live:tab$/, "Tabs"],
[/scope-switch|tier|^live:I18N-02 lang|^live:META-INTEL-07 respond|^live:GOOGLE-13 bucket|^live:lane|^live:META-DEC-01 lane/, "Segmented / radio group (scope, lanes, tiers)"],
[/ack$| assign$|mark-applied|source-toggle/, "Checkbox (assignment, ack, mark-applied)"],
[/business-switcher|account-picker|^live:SCOPE-05|^live:SCOPE-06/, "Combobox (business switcher, account/property/site pickers)"],
[/SCOPE-11 search|META-DEC-17 search|HIST-05 search|client-search/, "Global search overlay"],
[/search$/, "Global search overlay"],
[/menu$|filter$|preset$|sort$|window-picker|expiry$| level$|^live:META-DEC-02/, "Menu button + menu"],
[/open-inspector|open-client|CREATIVE-02 open$|^live:REPORT-08 open$/, "Row button (decision/list rows)"],
[/widget-select|keyboard-mode/, "Selectable card (report widget)"],
[/nudge-|^live:REPORT-03 undo|^live:REPORT-03 exit/, "Icon button (nudge, close, menu ⋯)"],
[/carousel-dot/, "Dot pagination (carousel)"],
[/chart-table-toggle/, "Chart/table toggle"],
[/load-more|cursor$/, "Load more / cursor pagination"],
[/media-play|media-retry|^live:REPORT-08 retry/, "Media play / retry"],
[/scope-sheet/, "Scope sheet trigger (mobile header)"],
[/^disabled:/, "Disabled control with reason"],
[/email$|password$|current$|new$|name$|ECON-0[13] edit/, "Text input (auth, settings, economics)"],
[/edit$|^live:AGENCY-02|^live:HEALTH-01|^live:ECON-04|deeplink|^live:GOOGLE-30$|^live:PUBLIC|^live:CREATIVE-02 back|^live:LAUNCH-0[12] fix|^live:SHOPIFY-01|^live:INTEGRATION-03 connect$|^live:INTEGRATION-0[237]$|^live:SCOPE-03 assign|^live:SCOPE-12 result|^live:META-DEC-13 open/, "Link action (Open · Edit · Duplicate)"],
[/.*/, "Button (primary/secondary/danger)"]
];
export function compFor(key){ for(const [re,c] of MAP){ if(re.test(key)) return c; } return "Button (primary/secondary/danger)"; }
export function validateSemantics(contractKeys){
  const names=new Set(COMPONENTS.map(c=>c.component));
  const unmapped=contractKeys.filter(k=>!names.has(compFor(k)));
  const incomplete=COMPONENTS.filter(c=>["component","native","role","name","states","keyboard","focus","errors","responsive"].some(f=>!c[f]||!String(c[f]).trim())).map(c=>c.component);
  return {components:COMPONENTS.length,unmapped,incomplete,ok:unmapped.length===0&&incomplete.length===0};
}
// Range alias modeling: the one deliberately templated range key and its exact expansion.
export const RANGE_ALIASES=[{alias:"gated:META-WF-02..08 menu",expandsTo:["META-WF-02","META-WF-03","META-WF-04","META-WF-05","META-WF-06","META-WF-07","META-WF-08"],why:"one workflow menu control transitions all seven states; modeled as a single contract, expansion asserted by REQ-09"}];
// Production verification that a static package CANNOT perform — retained as named
// implementation-stage gates (owners: engineering + accessibility QA), never claimed here.
export const IMPLEMENTATION_GATES=[
{id:"IG-1",gate:"Assistive technology pass",detail:"NVDA+Chrome, VoiceOver+Safari (macOS/iOS), TalkBack+Chrome across the 13 flows; names/roles/values match this matrix"},
{id:"IG-2",gate:"Keyboard-only traversal",detail:"Every flow completable keyboard-only; no traps outside overlays; visible ring everywhere (2.4.7/2.1.2)"},
{id:"IG-3",gate:"Zoom & reflow",detail:"200% and 400% zoom: no loss of content/function, no 2-D scroll except data tables (1.4.4/1.4.10)"},
{id:"IG-4",gate:"Print output",detail:"H39 print surface produces paginated, chart-as-table PDF from the real renderer"},
{id:"IG-5",gate:"Live-region behavior",detail:"role=status announcements fire exactly as specified (4.1.3) — preflight age, progress, outcomes, copied, counts"},
{id:"IG-6",gate:"Reduced motion",detail:"prefers-reduced-motion collapses transitions to ≤80ms opacity"},
{id:"IG-7",gate:"Real AT focus management",detail:"traps, Escape, focus return per Dialog/Drawer rows above"}];

// Next.js App Router page files may only export `default` plus reserved page
// exports. The automation surface additionally exports `MetaAutomationView`
// (rendered directly in tests), so the implementation lives in
// ./automation-view and this page re-exports only the default component —
// same pattern as platforms/google/pulse/page.tsx.
export { default } from "./automation-view";

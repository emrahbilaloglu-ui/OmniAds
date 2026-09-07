// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MetaDecisionCenterExact } from "@/components/meta/decision-center/MetaDecisionCenterExact";
import { decisionCenterFixture } from "@/scripts/zero-base/fixtures/decision-center";

function renderDecisionCenter(options: {
  selected?: boolean;
  conflict?: boolean;
  paging?: boolean;
  sticky?: boolean;
}) {
  return renderToStaticMarkup(
    React.createElement(MetaDecisionCenterExact, {
      adsManagerHref:
        "https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=298410771",
      lane: options.paging ? "needsres" : "action",
      scope: "structure",
      onCloseInspector: () => {},
      onLaneChange: () => {},
      onLevelsChange: () => {},
      onScopeChange: () => {},
      onSearchChange: () => {},
      onSortChange: () => {},
      viewModel: decisionCenterFixture({
        rows: 3,
        blocked: options.paging ? 30 : 2,
        selected: options.selected === true,
        conflict: options.conflict === true,
        stickyBar: options.sticky === true,
      }),
    }),
  );
}

describe("the mounted Decision Center keeps the compact operator surface", () => {
  it.each([
    ["default", {}],
    ["selected row", { selected: true }],
    ["blocked queue", { paging: true, selected: true }],
    ["conflict state", { selected: true, conflict: true }],
    ["narrow state", { selected: true, sticky: true }],
  ] as const)(
    "renders %s without restoring removed diagnostics",
    (_name, options) => {
      const html = renderDecisionCenter(options);

      expect(html).toContain('data-screen-label="Meta Decision Center"');
      expect(html).toContain("data-meta-exact-workspace");
      expect(html).toContain('data-meta-exact-lane="action"');
      expect(html).toContain('data-meta-exact-lane="needsres"');
      expect(html).toContain('data-meta-exact-lane="watching"');
      expect(html).not.toContain("assigned-account-coverage");
      expect(html).not.toContain("Source provenance");
    },
  );
});

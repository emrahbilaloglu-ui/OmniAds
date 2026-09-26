import { describe, expect, it } from "vitest";
import { entityRoleNameSuggestion } from "./entity-role-name-suggestion";

describe("entity name role review suggestions", () => {
  it.each([
    ["TS_MAIN_DPA_BIDCAP", "main"],
    ["EmB - Purchase-Test(Hasan Hoca)-ABO-1 Eylül", "test"],
    ["TS_TEST_Q037_Cycle08", "test"],
    ["Main / Test", "conflict"],
    ["Contest - Mainland - Latest - Retest", null],
    ["Testimonial - Maintain", null],
    ["Broad", null],
    ["", null],
  ])("%s is a %s review hint", (name, expected) => {
    expect(entityRoleNameSuggestion(name!)).toBe(expected);
  });
});

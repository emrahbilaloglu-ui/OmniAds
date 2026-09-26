/** Review aid only. The authority reader never reads entity names. */
export function entityRoleNameSuggestion(name: string): "main" | "test" | "conflict" | null {
  const words = new Set(name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const main = words.has("main");
  const test = words.has("test");
  if (main && test) return "conflict";
  return main ? "main" : test ? "test" : null;
}

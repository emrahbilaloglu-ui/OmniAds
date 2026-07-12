import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [path];
  });
}

describe("canonical calendar adoption", () => {
  it("keeps user-facing app code off native date inputs and the removed HTML picker", () => {
    const root = process.cwd();
    const files = [join(root, "app"), join(root, "components")].flatMap(sourceFiles);
    const offenders = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      if (!/type\s*=\s*["']date["']|HtmlDateRangePicker/.test(source)) return [];
      return [relative(root, file)];
    });

    expect(offenders).toEqual([]);
  });
});

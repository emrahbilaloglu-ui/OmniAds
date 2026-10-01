import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function buildNativeHistoricalWorker(projectRoot, entry, outputDirectory) {
  const { build } = await import(pathToFileURL(join(projectRoot, "node_modules/esbuild/lib/main.js")).href);
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const result = await build({ entryPoints: [entry], outfile: join(directory, "archive-worker.cjs"),
    absWorkingDir: projectRoot, platform: "node", target: "node20", format: "cjs", bundle: true,
    tsconfig: join(projectRoot, "tsconfig.json"), metafile: true, sourcemap: false, minify: false,
    logLevel: "error" });
  const bytes = await readFile(join(directory, "archive-worker.cjs"));
  const manifest = { contract: "native-historical-worker-artifact.v1",
    sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { ...manifest, sourceInputs: Object.keys(result.metafile.inputs).length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  console.log(JSON.stringify(await buildNativeHistoricalWorker(root,
    join(root, "lib/creative-decision-engine/native-historical-archive-worker.ts"), join(root, ".native-historical-worker"))));
}

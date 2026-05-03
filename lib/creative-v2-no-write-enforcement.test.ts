// Creative v2 hardening file: read-only safety gate; behavior unchanged.
// Public Raw verification marker: multiline LF formatting required.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const previewRouteFile = "app/api/creatives/decision-os-v2/preview/route.ts";
const previewModelFile = "lib/creative-decision-os-v2-preview.ts";
const previewComponentFile =
  "components/creatives/CreativeDecisionOsV2PreviewSurface.tsx";
const creativesPageFile = "app/(dashboard)/creatives/page.tsx";
const dataServiceFile = "src/services/data-service-ai.ts";
const previewSurfaceMarker = "<CreativeDecisionOsV2PreviewSurface";
const postPreviewMarker = "<CreativeDecisionCenterSurface";
const mutatingRouteHandlerPattern =
  /export async function (POST|PUT|PATCH|DELETE)\b/;
const commandCenterBoundaryPattern =
  /command-center|execution\/apply|work[-_ ]?item/i;
const writeVerbPattern =
  /\b(enqueue|upsert|insert|update|delete|applyCommandCenter)\b/i;
const metaWriteBoundaryPattern =
  /@\/lib\/meta|@\/lib\/api\/meta|MetaApi|facebook/i;
const dbPlatformWritePattern = /@\/lib\/db|@\/lib\/meta|@\/lib\/api\/meta/i;
const writeSideEffectPattern =
  /\bfetch\s*\(|\bsql`|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i;

function source(file: string) {
  return readFileSync(file, "utf8");
}

function functionBody(file: string, functionName: string) {
  const text = source(file);
  const start = text.indexOf(`function ${functionName}`);
  if (start < 0) throw new Error(`Missing function ${functionName} in ${file}`);
  const nextExport = text.indexOf("\nexport ", start + functionName.length);
  if (nextExport > start) return text.slice(start, nextExport);
  const bodyStart = text.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`Could not parse function ${functionName} in ${file}`);
}

function callbackBody(file: string, declaration: string) {
  const text = source(file);
  const start = text.indexOf(declaration);
  if (start < 0)
    throw new Error(`Missing declaration ${declaration} in ${file}`);
  const end = text.indexOf("}, []);", start);
  if (end < 0)
    throw new Error(`Could not parse callback ${declaration} in ${file}`);
  return text.slice(start, end + "}, []);".length);
}

function sourceSliceBetween(
  text: string,
  startMarker: string,
  endMarker: string,
) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing start marker ${startMarker}`);

  const end = text.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Missing end marker ${endMarker}`);

  return text.slice(start, end);
}

describe("Creative v2 no-write enforcement", () => {
  it("keeps the preview route GET-only and free of write boundary imports", () => {
    const text = source(previewRouteFile);

    expect(text).toMatch(/export async function GET/);
    expect(text).not.toMatch(mutatingRouteHandlerPattern);
    expect(text).not.toMatch(commandCenterBoundaryPattern);
    expect(text).not.toMatch(writeVerbPattern);
    expect(text).not.toMatch(metaWriteBoundaryPattern);
  });

  it("keeps the preview route clean in the transitive GET side-effect scanner", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/check-request-path-side-effects.ts",
        "--json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      findings: Array<{ type: string; file: string; summary: string }>;
    };
    const previewFindings = payload.findings.filter((finding) =>
      finding.file.endsWith(previewRouteFile),
    );

    expect(previewFindings).toEqual([]);
  }, 30_000);

  it("keeps preview model and component detached from DB, platform, and Command Center writes", () => {
    const combined = [previewModelFile, previewComponentFile]
      .map(source)
      .join("\n");

    expect(combined).not.toMatch(dbPlatformWritePattern);
    expect(combined).not.toMatch(commandCenterBoundaryPattern);
    expect(combined).not.toMatch(writeSideEffectPattern);
    expect(combined).not.toMatch(
      /\b(enqueue|upsert|insert|delete|applyCommandCenter)\b/i,
    );
  });

  it("keeps v2 row detail/open interactions local to the existing read-only drawer", () => {
    const pageSource = source(creativesPageFile);
    const openDrawer = callbackBody(
      creativesPageFile,
      "const openCreativeDrawer = useCallback",
    );
    const v2SurfaceUsage = sourceSliceBetween(
      pageSource,
      previewSurfaceMarker,
      postPreviewMarker,
    );

    expect(openDrawer).toContain("setCreativeDrawerState");
    expect(openDrawer).toContain("scrollIntoView");
    expect(openDrawer).not.toMatch(
      /\bfetch\s*\(|runCreativeDecisionOsAnalysis|mutate\(|command-center/i,
    );
    expect(v2SurfaceUsage).toContain(
      "onOpenRow={(rowId) => openCreativeDrawer(rowId, true)}",
    );
    expect(v2SurfaceUsage).not.toMatch(
      /runCreativeDecisionOsAnalysis|CommandCenter|queue|apply/i,
    );
  });

  it("keeps the client preview fetch path GET-only with no request body", () => {
    const body = functionBody(
      dataServiceFile,
      "getCreativeDecisionOsV2Preview",
    );

    expect(body).toContain("/api/creatives/decision-os-v2/preview");
    expect(body).toContain('method: "GET"');
    expect(body).toContain('cache: "no-store"');
    expect(body).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    expect(body).not.toMatch(/\bbody:/);
  });
});

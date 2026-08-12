/**
 * The Ops route matrix, the server-side gate, and the buyer/Ops separation.
 *
 * These assert against the real filesystem and the real shipped buyer surfaces
 * rather than a description of them: a tuple that resolves in a constant but
 * has no route file is a 404 nobody finds until an operator needs it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  OPS_LEAVES,
  OPS_NAV,
  OPS_NON_ADMIN_REDIRECT,
  OPS_SURFACE_TOKEN,
  adminForOps,
  opsForAdmin,
} from "@/lib/zero-base/ops/ops-routes";

const ROOT = process.cwd();

function pageFor(routePath: string): string {
  const rel = routePath === "/ops" ? "app/ops/page.tsx" : `app${routePath}/page.tsx`;
  return path.join(ROOT, rel);
}

describe("every legacy admin route has exactly one canonical Ops tuple", () => {
  it("covers all 16 admin pages and no more", () => {
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (entry === "page.tsx") out.push(full);
      }
      return out;
    }
    const adminPages = walk(path.join(ROOT, "app", "admin")).map((file) =>
      "/" + path.relative(ROOT, path.dirname(file)).replace(/^app\//, ""),
    );
    expect(adminPages).toHaveLength(16);
    expect(OPS_LEAVES).toHaveLength(16);

    for (const admin of adminPages) {
      expect(opsForAdmin(admin), `no Ops tuple for ${admin}`).not.toBeNull();
    }
  });

  it("resolves in both directions with no duplicates", () => {
    const opsPaths = OPS_LEAVES.map((l) => l.ops);
    const adminPaths = OPS_LEAVES.map((l) => l.admin);
    expect(new Set(opsPaths).size).toBe(opsPaths.length);
    expect(new Set(adminPaths).size).toBe(adminPaths.length);
    for (const leaf of OPS_LEAVES) {
      expect(adminForOps(leaf.ops)?.admin).toBe(leaf.admin);
      expect(opsForAdmin(leaf.admin)?.ops).toBe(leaf.ops);
    }
  });

  it("every Ops tuple has a real route file on disk", () => {
    // A tuple that resolves in a constant but has no page is a 404 an operator
    // finds during an incident.
    for (const leaf of OPS_LEAVES) {
      expect(existsSync(pageFor(leaf.ops)), leaf.ops).toBe(true);
    }
  });

  it("leaves every legacy admin route intact", () => {
    for (const leaf of OPS_LEAVES) {
      const rel = leaf.admin === "/admin" ? "app/admin/legacy-page.tsx" : `app${leaf.admin}/page.tsx`;
      expect(existsSync(path.join(ROOT, rel)), leaf.admin).toBe(true);
    }
  });

  it("hides dynamic detail routes from the nav", () => {
    expect(OPS_NAV.every((leaf) => !leaf.dynamic)).toBe(true);
    expect(OPS_NAV.length).toBe(OPS_LEAVES.filter((l) => !l.dynamic).length);
  });
});

describe("Ops reuses admin logic rather than duplicating it", () => {
  it("mounts the existing admin component in each mirrored page", () => {
    // Duplicated operational logic would drift from the admin behaviour it is
    // supposed to mirror; importing it means the semantics cannot diverge.
    const reused = OPS_LEAVES.filter((leaf) => {
      const source = readFileSync(pageFor(leaf.ops), "utf8");
      return /@\/app\/admin\//.test(source) || /@\/components\/admin\//.test(source);
    });
    expect(reused).toHaveLength(OPS_LEAVES.length);
  });

  it("restates no action endpoint of its own", () => {
    for (const leaf of OPS_LEAVES) {
      const source = readFileSync(pageFor(leaf.ops), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
      // No fetch and no /api/admin string: the mounted component owns both.
      expect(/fetch\(/.test(source), leaf.ops).toBe(false);
      expect(source.includes("/api/admin"), leaf.ops).toBe(false);
    }
  });
});

describe("the gate is server-side and matches the legacy shell", () => {
  const layout = readFileSync(path.join(ROOT, "app", "ops", "layout.tsx"), "utf8");
  const adminLayout = readFileSync(path.join(ROOT, "app", "admin", "layout.tsx"), "utf8");

  it("checks the session and superadmin on the server", () => {
    expect(layout).toContain("getSessionFromCookies");
    expect(layout).toContain("isSuperadmin");
    // A client check would be a suggestion, not a boundary.
    expect(layout.startsWith('"use client"')).toBe(false);
  });

  it("uses the same two guards the admin shell uses", () => {
    for (const guard of ["getSessionFromCookies", "isSuperadmin"]) {
      expect(adminLayout.includes(guard), guard).toBe(true);
      expect(layout.includes(guard), guard).toBe(true);
    }
  });

  it("redirects a signed-in non-admin away rather than rendering an empty shell", () => {
    expect(layout).toContain("OPS_NON_ADMIN_REDIRECT");
    expect(OPS_NON_ADMIN_REDIRECT).toBe("/overview");
  });

  it("redirects an anonymous visitor to login", () => {
    expect(layout).toMatch(/if \(!session\) redirect\("\/login"\)/);
  });
});

describe("buyer surfaces link to Ops zero times", () => {
  function walk(dir: string, filter: (f: string) => boolean): string[] {
    const out: string[] = [];
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full, filter));
      else if (filter(full)) out.push(full);
    }
    return out;
  }

  const buyerFiles = [
    ...walk(path.join(ROOT, "components", "zero-base"), (f) => /\.tsx?$/.test(f) && !/\.test\./.test(f)),
    ...walk(path.join(ROOT, "app", "c"), (f) => /\.tsx?$/.test(f) && !/\.test\./.test(f)),
  ];

  it("scans a non-empty set of buyer files", () => {
    expect(buyerFiles.length).toBeGreaterThan(20);
  });

  it("contains no link or reference to an Ops route", () => {
    for (const file of buyerFiles) {
      // Ops components live under components/zero-base/ops by design.
      if (file.includes(path.join("zero-base", "ops"))) continue;
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
      expect(/["'`]\/ops(\/|["'`])/.test(source), `${path.basename(file)} links to /ops`).toBe(false);
      expect(source.includes("ops-routes"), path.basename(file)).toBe(false);
    }
  });

  it("keeps the Ops surface token out of buyer files", () => {
    for (const file of buyerFiles) {
      if (file.includes(path.join("zero-base", "ops"))) continue;
      expect(readFileSync(file, "utf8").includes(OPS_SURFACE_TOKEN), path.basename(file)).toBe(false);
    }
  });
});

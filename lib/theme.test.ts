import { describe, expect, it } from "vitest";

import {
  DEFAULT_THEME_PREFERENCE,
  NO_FLASH_SCRIPT,
  THEME_ATTRIBUTE,
  THEME_COOKIE_NAME,
  parseThemePreference,
  resolveTheme,
  resolveThemeForServer,
  themeCookieAttributes,
} from "@/lib/theme";

describe("parseThemePreference", () => {
  it("accepts the three valid preferences", () => {
    for (const value of ["system", "light", "dark"] as const) {
      expect(parseThemePreference(value)).toBe(value);
    }
    expect(parseThemePreference(" DARK ")).toBe("dark");
  });

  it("falls back to system for anything else rather than guessing a colour", () => {
    for (const value of ["", "nope", "Dark mode", null, undefined]) {
      expect(parseThemePreference(value), String(value)).toBe("system");
    }
    expect(DEFAULT_THEME_PREFERENCE).toBe("system");
  });
});

describe("resolveThemeForServer", () => {
  it("resolves an explicit preference", () => {
    expect(resolveThemeForServer("light")).toBe("light");
    expect(resolveThemeForServer("dark")).toBe("dark");
  });

  it("returns null for system instead of inventing one", () => {
    // The server cannot know the OS setting. Returning "light" here is exactly
    // what makes a dark-mode device flash white.
    expect(resolveThemeForServer("system")).toBeNull();
  });
});

describe("resolveTheme", () => {
  it("follows the system signal only for the system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("theme cookie", () => {
  it("is long-lived, path-wide and SameSite=Lax", () => {
    const cookie = themeCookieAttributes("dark");
    expect(cookie).toContain(`${THEME_COOKIE_NAME}=dark`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=31536000");
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("no-flash script", () => {
  it("returns early for an explicit preference so it cannot fight the server", () => {
    const run = (cookie: string, prefersDark: boolean) => {
      const documentStub = { cookie, documentElement: { attrs: {} as Record<string, string> } };
      const setAttribute = (name: string, value: string) => {
        documentStub.documentElement.attrs[name] = value;
      };
      const fn = new Function(
        "document",
        "window",
        NO_FLASH_SCRIPT.replace(
          "document.documentElement.setAttribute",
          "document.documentElement.__set",
        ),
      );
      (documentStub.documentElement as unknown as { __set: typeof setAttribute }).__set =
        setAttribute;
      fn(documentStub, { matchMedia: () => ({ matches: prefersDark }) });
      return documentStub.documentElement.attrs;
    };

    expect(run(`${THEME_COOKIE_NAME}=light`, true)).toEqual({});
    expect(run(`${THEME_COOKIE_NAME}=dark`, false)).toEqual({});
  });

  it("settles a system preference from matchMedia", () => {
    const run = (cookie: string, prefersDark: boolean) => {
      const attrs: Record<string, string> = {};
      const documentStub = {
        cookie,
        documentElement: { setAttribute: (n: string, v: string) => { attrs[n] = v; } },
      };
      new Function("document", "window", NO_FLASH_SCRIPT)(documentStub, {
        matchMedia: () => ({ matches: prefersDark }),
      });
      return attrs;
    };

    expect(run(`${THEME_COOKIE_NAME}=system`, true)).toEqual({ [THEME_ATTRIBUTE]: "dark" });
    expect(run(`${THEME_COOKIE_NAME}=system`, false)).toEqual({ [THEME_ATTRIBUTE]: "light" });
    // No cookie at all behaves like system.
    expect(run("", true)).toEqual({ [THEME_ATTRIBUTE]: "dark" });
  });

  it("never throws, whatever the document looks like", () => {
    expect(() => {
      new Function("document", "window", NO_FLASH_SCRIPT)({}, {});
    }).not.toThrow();
  });
});

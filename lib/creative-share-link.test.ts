import { describe, expect, it } from "vitest";

import {
  creativeSharePath,
  normalizeCreativeShareToken,
  resolveCreativeShareUrl,
} from "@/lib/creative-share-link";

const TOKEN = "23d6ad85215f4fdf967010efbcb0a5c2";

describe("creative share links", () => {
  it("builds a portable absolute link from the trusted browser origin", () => {
    expect(
      resolveCreativeShareUrl(
        { token: TOKEN, url: `/share/creative/${TOKEN}` },
        "https://adsecute.com",
      ),
    ).toBe(`https://adsecute.com/share/creative/${TOKEN}`);
  });

  it("uses the token rather than a server-supplied foreign origin", () => {
    expect(
      resolveCreativeShareUrl(
        { url: `https://attacker.example/share/creative/${TOKEN}` },
        "https://adsecute.com",
      ),
    ).toBe(`https://adsecute.com/share/creative/${TOKEN}`);
  });

  it("preserves localhost ports for local previews", () => {
    expect(
      resolveCreativeShareUrl({ path: `/share/creative/${TOKEN}` }, "http://localhost:3000"),
    ).toBe(`http://localhost:3000/share/creative/${TOKEN}`);
  });

  it.each(["", "share_token", "../../admin", `${TOKEN}extra`, null, undefined])(
    "rejects malformed token %j",
    (value) => {
      expect(normalizeCreativeShareToken(value)).toBeNull();
      expect(creativeSharePath(value)).toBeNull();
    },
  );
});

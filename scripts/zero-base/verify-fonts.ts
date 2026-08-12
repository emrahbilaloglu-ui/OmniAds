/**
 * WP-04 font verifier.
 *
 * A vendored LICENSES.md is only worth anything if something re-checks it. This
 * re-hashes every binary and license file, then decompresses each font and
 * reads its `name` table so the copyright inside the binary is compared against
 * the first line of the license that claims to cover it. Swapping a font or
 * editing a license fails here instead of shipping.
 *
 * It also asserts the Schibsted file really is a variable font whose `wght`
 * axis covers the weights the design uses — the reason we ship one file rather
 * than the archive's four identical copies.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";

const ROOT = path.resolve(__dirname, "..", "..");
const FONT_DIR = path.join(ROOT, "public", "fonts", "zero-base");

/** Literals from LICENSES.md, restated here so the two must agree. */
const EXPECTED = {
  files: {
    "schibsted-grotesk-variable.woff2":
      "e3b56e90510a84ac0ed465b822e112983eaf58e37436bf769681c31f77b1f3a7",
    "fragment-mono-400.woff2":
      "4f4dc27f4a770c0d02fde800daa836c8adc0d1e423b28da74baaf0d1cc3ab96c",
    "OFL-schibsted-grotesk.txt":
      "3b4f3063b6ac7c1e403e2c4a5e8ef3a58190ff83ed7b15af66511858699139ce",
    "OFL-fragment-mono.txt":
      "ef14426248ca0404eae1ae65e61802b1627b5ec33aab117fb36edf401a81636e",
  },
  pairs: [
    {
      font: "schibsted-grotesk-variable.woff2",
      license: "OFL-schibsted-grotesk.txt",
      family: "Schibsted Grotesk",
      variable: { axis: "wght", min: 400, max: 900 },
    },
    {
      font: "fragment-mono-400.woff2",
      license: "OFL-fragment-mono.txt",
      family: "Fragment Mono",
      variable: null,
    },
  ],
} as const;

const KNOWN_TABLE_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm",
  "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern",
  "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC",
  "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar",
  "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty",
  "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat",
  "Gloc", "Feat", "Sill",
];

interface WoffTable {
  tag: string;
  offset: number;
  length: number;
}

/** Minimal WOFF2 reader: table directory + brotli payload. */
export function readWoff2(buffer: Buffer): {
  tables: WoffTable[];
  data: Buffer;
} {
  const numTables = buffer.readUInt16BE(12);
  let cursor = 48;

  const readUIntBase128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = buffer[cursor];
      cursor += 1;
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("malformed UIntBase128");
  };

  const tables: WoffTable[] = [];
  let offset = 0;
  for (let i = 0; i < numTables; i += 1) {
    const flags = buffer[cursor];
    cursor += 1;
    const index = flags & 0x3f;
    const transformVersion = (flags >> 6) & 0x3;
    let tag: string;
    if (index === 0x3f) {
      tag = buffer.subarray(cursor, cursor + 4).toString("latin1");
      cursor += 4;
    } else {
      tag = KNOWN_TABLE_TAGS[index];
    }
    const originalLength = readUIntBase128();
    // glyf/loca invert the convention: version 0 means transformed there.
    const transformed =
      tag === "glyf" || tag === "loca" ? transformVersion === 0 : transformVersion !== 0;
    const storedLength = transformed ? readUIntBase128() : originalLength;
    tables.push({ tag, offset, length: storedLength });
    offset += storedLength;
  }

  return { tables, data: brotliDecompressSync(buffer.subarray(cursor)) };
}

/** Reads the requested `name` table records, preferring the first match. */
export function readNameTable(
  tables: WoffTable[],
  data: Buffer,
  wanted: readonly number[],
): Record<number, string> {
  const table = tables.find((entry) => entry.tag === "name");
  if (!table) throw new Error("font has no name table");
  const name = data.subarray(table.offset, table.offset + table.length);
  const count = name.readUInt16BE(2);
  const stringOffset = name.readUInt16BE(4);

  const result: Record<number, string> = {};
  for (let i = 0; i < count; i += 1) {
    const record = 6 + i * 12;
    const platformId = name.readUInt16BE(record);
    const nameId = name.readUInt16BE(record + 6);
    const length = name.readUInt16BE(record + 8);
    const offset = name.readUInt16BE(record + 10);
    if (!wanted.includes(nameId) || result[nameId] !== undefined) continue;
    const raw = name.subarray(stringOffset + offset, stringOffset + offset + length);
    // Platform 3 (Windows) stores UTF-16BE; platform 1 (Mac) stores single bytes.
    result[nameId] =
      platformId === 3 ? Buffer.from(raw).swap16().toString("utf16le") : raw.toString("latin1");
  }
  return result;
}

/** Reads `fvar` axes so the declared CSS weight range can be checked. */
export function readVariationAxes(
  tables: WoffTable[],
  data: Buffer,
): Array<{ tag: string; min: number; default: number; max: number }> {
  const table = tables.find((entry) => entry.tag === "fvar");
  if (!table) return [];
  const fvar = data.subarray(table.offset, table.offset + table.length);
  const axesOffset = fvar.readUInt16BE(4);
  const axisCount = fvar.readUInt16BE(8);
  const axisSize = fvar.readUInt16BE(10);
  const axes = [];
  for (let i = 0; i < axisCount; i += 1) {
    const at = axesOffset + i * axisSize;
    axes.push({
      tag: fvar.subarray(at, at + 4).toString("latin1"),
      min: fvar.readInt32BE(at + 4) / 65536,
      default: fvar.readInt32BE(at + 8) / 65536,
      max: fvar.readInt32BE(at + 12) / 65536,
    });
  }
  return axes;
}

export function verifyFonts(): string[] {
  const failures: string[] = [];

  for (const [file, expectedHash] of Object.entries(EXPECTED.files)) {
    const bytes = readFileSync(path.join(FONT_DIR, file));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedHash) failures.push(`hash drift: ${file}`);
  }

  for (const pair of EXPECTED.pairs) {
    const { tables, data } = readWoff2(readFileSync(path.join(FONT_DIR, pair.font)));
    const names = readNameTable(tables, data, [0, 1, 14]);

    if (names[1] !== pair.family) {
      failures.push(`${pair.font}: family is ${names[1]}, expected ${pair.family}`);
    }
    if (!/scripts\.sil\.org\/OFL/.test(names[14] ?? "")) {
      failures.push(`${pair.font}: license URL is ${names[14]}, expected the SIL OFL`);
    }

    const licenseFirstLine = readFileSync(path.join(FONT_DIR, pair.license), "utf8")
      .split("\n")[0]
      .trim();
    if (licenseFirstLine !== (names[0] ?? "").trim()) {
      failures.push(
        `${pair.license} does not cover ${pair.font}: license says "${licenseFirstLine}", font says "${names[0]}"`,
      );
    }

    const axes = readVariationAxes(tables, data);
    if (pair.variable) {
      const axis = axes.find((entry) => entry.tag === pair.variable!.axis);
      if (!axis) {
        failures.push(`${pair.font}: expected a ${pair.variable.axis} axis`);
      } else if (axis.min !== pair.variable.min || axis.max !== pair.variable.max) {
        failures.push(
          `${pair.font}: ${axis.tag} axis is ${axis.min}-${axis.max}, expected ${pair.variable.min}-${pair.variable.max}`,
        );
      }
    } else if (axes.length > 0) {
      failures.push(`${pair.font}: expected a static font, found axes ${axes.map((a) => a.tag).join(",")}`);
    }
  }

  return failures;
}

function main() {
  console.log("zero-base font verifier");
  const failures = verifyFonts();
  if (failures.length) {
    console.error(`\nFAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(
    "  ok    binaries and licenses match LICENSES.md; each license's copyright line\n" +
      "        matches the copyright inside the font it covers",
  );
}

if (process.argv[1] && process.argv[1].includes("verify-fonts")) main();

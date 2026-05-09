import type { FrameGrainTheme } from "./frameGrainCategoryHex";

type RGB = readonly [number, number, number];

function parseHex(s: string): RGB | null {
  const m = s.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  const u = Math.min(1, Math.max(0, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ] as const;
}

/** Paper node AZ-0 reference hues, biased toward the active category (tokens.css / Paper file). */
const PAPER_REF: RGB[] = [
  [0x73, 0x00, 0xff],
  [0xeb, 0xa8, 0xff],
  [0x00, 0xbf, 0xff],
  [0x94, 0x00, 0xb8],
];

const PAPER_WASH: RGB = [0xf5, 0xf0, 0xe6];
const MINIMAL_WASH: RGB = [0xf5, 0xf5, 0xf7];

export function mobileFrameGrainPalette(
  theme: FrameGrainTheme,
  frameHex: string,
  textHex: string,
): { colors: string[]; colorBack: string; baseHex: string } {
  const fc = parseHex(frameHex) ?? [0x2a, 0x3e, 0xc5];
  const tc = parseHex(textHex) ?? [0xff, 0xff, 0xff];

  if (theme === "minimal") {
    const wash = mix(fc, MINIMAL_WASH, 0.72);
    return {
      colors: [
        toHex(mix(fc, wash, 0.2)),
        toHex(mix(fc, tc, 0.38)),
        toHex(mix(fc, [0xe5, 0xe5, 0xea], 0.45)),
        toHex(mix(fc, [0x42, 0x42, 0x45], 0.22)),
      ],
      colorBack: "#00000000",
      baseHex: toHex(wash),
    };
  }

  if (theme === "paper") {
    const colors = PAPER_REF.map((ref, i) => toHex(mix(ref, fc, 0.42 + i * 0.04)));
    return {
      colors,
      colorBack: "#00000000",
      baseHex: toHex(mix(fc, PAPER_WASH, 0.38)),
    };
  }

  return {
    colors: [
      toHex(fc),
      toHex(mix(fc, tc, 0.55)),
      toHex(mix(fc, [0xff, 0xff, 0xff], 0.38)),
      toHex(mix(fc, [0x12, 0x12, 0x12], 0.28)),
    ],
    colorBack: "#00000000",
    baseHex: toHex(mix(fc, [0xf4, 0xf4, 0xf4], 0.22)),
  };
}

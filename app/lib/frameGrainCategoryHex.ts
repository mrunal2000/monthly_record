/** Resolves category frame colors to hex for WebGL shaders (CSS `var(--category-*)` is not valid there). */
export type FrameGrainTheme = "paper" | "brutalist" | "minimal";

const HEX: Record<FrameGrainTheme, Record<string, { frame: string; text: string }>> = {
  paper: {
    media: { frame: "#8b2635", text: "#faf7ef" },
    books: { frame: "#34495e", text: "#faf7ef" },
    misc: { frame: "#5c4a38", text: "#faf7ef" },
    wishlist: { frame: "#746c5e", text: "#121212" },
    restaurants: { frame: "#2d4739", text: "#faf7ef" },
    "rabbit-holes": { frame: "#5b3e6b", text: "#faf7ef" },
    quotes: { frame: "#285a61", text: "#faf7ef" },
  },
  brutalist: {
    media: { frame: "#6d8bff", text: "#070808" },
    books: { frame: "#ff7eb3", text: "#070808" },
    misc: { frame: "#d4a3ff", text: "#070808" },
    wishlist: { frame: "#7ee8d3", text: "#070808" },
    restaurants: { frame: "#9be06c", text: "#070808" },
    "rabbit-holes": { frame: "#b07cff", text: "#070808" },
    quotes: { frame: "#ffa64d", text: "#070808" },
  },
  minimal: {
    media: { frame: "#0071e3", text: "#f5f5f7" },
    books: { frame: "#424245", text: "#f5f5f7" },
    misc: { frame: "#636366", text: "#f5f5f7" },
    wishlist: { frame: "#d2d2d7", text: "#1d1d1f" },
    restaurants: { frame: "#515154", text: "#f5f5f7" },
    "rabbit-holes": { frame: "#7c3aed", text: "#f5f5f7" },
    quotes: { frame: "#0d9488", text: "#f5f5f7" },
  },
};

export function resolveCategoryHexForGrain(
  theme: FrameGrainTheme,
  categoryId: string,
): { frame: string; text: string } {
  return HEX[theme][categoryId] ?? { frame: "#6d8bff", text: "#faf7ef" };
}

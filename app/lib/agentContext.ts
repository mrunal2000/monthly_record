import { isSupportedVisionImageUrl } from "./openAiVisionImageUrl";

export type AgentMonthMeta = { id: string; label: string };

export type AgentCategoryMeta = {
  id: string;
  label: string;
  note: string;
};

export type AgentFavoriteImageSnap = {
  id: string;
  src: string;
};

export function buildAgentVisionImageRefs(
  months: AgentMonthMeta[],
  categories: AgentCategoryMeta[],
  imagesByBoard: Record<string, AgentFavoriteImageSnap[]>,
  opts?: { maxImages?: number },
): { caption: string; url: string }[] {
  const maxImages = opts?.maxImages ?? 22;
  const seen = new Set<string>();
  const out: { caption: string; url: string }[] = [];

  function isHttp(url: string) {
    try {
      const u = new URL(url);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }

  outer: for (const month of months) {
    for (const cat of categories) {
      const key = `${month.id}-${cat.id}`;
      const imgs = imagesByBoard[key] ?? [];

      imgs.forEach((img, idx) => {
        if (out.length >= maxImages) return;
        const u = typeof img.src === "string" ? img.src.trim() : "";
        if (!u || !isHttp(u) || seen.has(u) || !isSupportedVisionImageUrl(u)) return;
        seen.add(u);
        out.push({
          caption: `${month.label} · ${cat.label} · #${idx + 1}`,
          url: u,
        });
      });

      if (out.length >= maxImages) break outer;
    }
  }

  return out;
}

/** Human-readable corpus for LLM grounding (months × category frames × image URLs). */
export function buildAgentFavoritesContext(
  months: AgentMonthMeta[],
  categories: AgentCategoryMeta[],
  imagesByBoard: Record<string, AgentFavoriteImageSnap[]>,
  opts?: { maxChars?: number },
): string {
  const maxChars = opts?.maxChars ?? 92_000;
  const sections: string[] = [];

  sections.push(
    "Monthly favorites board · Each item is usually a cover/still/screenshot linked by URL.",
    "The assistant may receive the SAME images again as visuals (not only URLs) — read cover typography and artwork where possible.",
    "Some slots may store HEIC/HEIF URLs (iPhone originals); vision uses JPEG/PNG/WebP/GIF only — those URLs still appear below for reference.\n",
    "When suggesting books or media: connect to BOOKS · MEDIA · WISHLIST; say when titles are unclear or guesses.\n",
  );

  for (const month of months) {
    for (const cat of categories) {
      const key = `${month.id}-${cat.id}`;
      const imgs = imagesByBoard[key] ?? [];
      if (imgs.length === 0) continue;

      sections.push(`\n## ${month.label} · ${cat.label}`);
      sections.push(`Frame note for ${cat.label}: ${cat.note}`);

      imgs.forEach((img, idx) => {
        sections.push(`- #${idx + 1} (id:${img.id}) ${img.src}`);
      });
    }
  }

  let out = sections.join("\n");
  if (!out.includes("## ")) {
    out += "\n\n(No favorites with images loaded yet.)";
  }

  if (out.length > maxChars) {
    return `${out.slice(0, maxChars - 80)}\n\n…[truncated for model context limits]`;
  }

  return out;
}

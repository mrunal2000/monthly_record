import { isSupportedVisionImageUrl } from "./openAiVisionImageUrl";

export type AgentMonthMeta = { id: string; label: string };

export type AgentCategoryMeta = {
  id: string;
  label: string;
  note: string;
  variant?: "canvas" | "links" | "quotes";
};

export type AgentLinkSnap = {
  id: string;
  url: string;
  title: string;
  note: string;
};

export type AgentQuoteSnap = {
  id: string;
  text: string;
  source: string;
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
  opts?: {
    maxChars?: number;
    linksByBoard?: Record<string, AgentLinkSnap[]>;
    quotesByBoard?: Record<string, AgentQuoteSnap[]>;
  },
): string {
  const maxChars = opts?.maxChars ?? 92_000;
  const sections: string[] = [];
  const linksByBoard = opts?.linksByBoard ?? {};
  const quotesByBoard = opts?.quotesByBoard ?? {};

  sections.push(
    "Monthly favorites board · Frames can hold image collages (canvas), saved links (URLs), or short quotes/text.",
    "The assistant may receive the SAME collage images again as visuals (not only URLs) — read cover typography and artwork where possible.",
    "Some slots may store HEIC/HEIF URLs (iPhone originals); vision uses JPEG/PNG/WebP/GIF only — those URLs still appear below for reference.\n",
    "When answering 'what next?' or similar: suggest new books/media they don't already appear to have listed; don't only restate their board.\n",
  );

  for (const month of months) {
    for (const cat of categories) {
      const key = `${month.id}-${cat.id}`;
      const variant = cat.variant ?? "canvas";

      if (variant === "canvas") {
        const imgs = imagesByBoard[key] ?? [];
        if (imgs.length === 0) continue;

        sections.push(`\n## ${month.label} · ${cat.label} (images)`);
        sections.push(`Frame note for ${cat.label}: ${cat.note}`);

        imgs.forEach((img, idx) => {
          sections.push(`- #${idx + 1} (id:${img.id}) ${img.src}`);
        });
        continue;
      }

      if (variant === "links") {
        const links = linksByBoard[key] ?? [];
        if (links.length === 0) continue;

        sections.push(`\n## ${month.label} · ${cat.label} (links)`);
        sections.push(`Frame note for ${cat.label}: ${cat.note}`);

        links.forEach((link, idx) => {
          const title = link.title.trim() ? ` — ${link.title.trim()}` : "";
          const note = link.note.trim() ? ` · note: ${link.note.trim()}` : "";
          sections.push(`- #${idx + 1} (id:${link.id})${title} ${link.url}${note}`);
        });
        continue;
      }

      const quotes = quotesByBoard[key] ?? [];
      if (quotes.length === 0) continue;

      sections.push(`\n## ${month.label} · ${cat.label} (quotes)`);
      sections.push(`Frame note for ${cat.label}: ${cat.note}`);

      quotes.forEach((quote, idx) => {
        const src = quote.source.trim() ? ` — ${quote.source.trim()}` : "";
        sections.push(`- #${idx + 1} (id:${quote.id}) "${quote.text.replace(/\s+/g, " ").trim()}"${src}`);
      });
    }
  }

  let out = sections.join("\n");
  if (!out.includes("## ")) {
    out += "\n\n(No favorites content loaded yet — no images, links, or quotes in the export.)";
  }

  if (out.length > maxChars) {
    return `${out.slice(0, maxChars - 80)}\n\n…[truncated for model context limits]`;
  }

  return out;
}

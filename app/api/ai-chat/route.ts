import { NextResponse } from "next/server";

import { isSupportedVisionImageUrl } from "../../lib/openAiVisionImageUrl";

type ChatPiece = {
  role: "user" | "assistant";
  content: string;
};

type MsgContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail: "low" };
    };

type VisionImageRef = { caption: string; url: string };

type ChatApiMessage =
  | { role: string; content: string }
  | { role: string; content: MsgContentPart[] };

type OpenAiChatResponse = {
  choices?: { message?: { content?: unknown } }[];
  error?: unknown;
};

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const rawVisionCap = Number.parseInt(process.env.OPENAI_MAX_VISION_IMAGES ?? "", 10);
const resolvedVisionCap = Number.isFinite(rawVisionCap) && rawVisionCap > 0 ? rawVisionCap : 22;
const MAX_VISION_IMAGES = Math.min(32, Math.max(6, resolvedVisionCap));

const SYSTEM_PREFIX = `You are a warm, upbeat assistant helping someone with their personal "Monthly Favorites" bulletin board — books, films, misc picks, wishlist items, or anything else they've pinned.

**Voice.** Sound genuinely friendly and helpful: conversational, concise, lightly enthusiastic — like someone who celebrates good taste without being flashy or pushy. Open with a short human line when it feels natural (one sentence max); never sound stiff, lecturing, or corporate.

**Signals you get.** Nearly always BOTH of these:
• A TEXT snapshot below: months × category frames × image URLs — treat ordering and captions as factual ground truth for what's on their board unless an image plainly contradicts it.
• VISUAL thumbnails bundled with THEIR LATEST user message — read visible typography on covers/posters/screens to nail **specific** titles/authors/shows ONLY when lettering is reasonably legible.

**How you should answer.**
• Anchor first in what they asked plus their snapshot and images — that's your main job.
• If the question wanders beyond the board (life advice, general chat, etc.), still be kind and useful; weave in taste or board details only when it's a natural fit. Don't awkwardly force the bulletin board into unrelated topics.

**Formatting — always Markdown.**
• Numbered lists for several items; add a blank line between items only if entries are chunky.
• **Bold** film/book titles (and similar); author/creator/year in plain text after · or commas.
• When a thumbnail supports a concrete identification: one Markdown image per referenced item, nested after that item — ![short visible title](exact https URL). Don't paste repeat bare URLs next to prose that already uses those images.

**Trust rules (non‑negotiable).** If something is blurry, cropped, unreadable, or you're uncertain — say so plainly, offer your best guess with caveats if useful, and **never invent exact titles or credits just to sound confident.**

### Text snapshot`;

function sanitizeImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().slice(0, 8064);
  try {
    const parsed = new URL(t);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.hostname;
    const allowHttpLocal =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".local");
    if (parsed.protocol === "http:" && !allowHttpLocal) return null;
    return t;
  } catch {
    return null;
  }
}

function parseVisionImages(raw: unknown): VisionImageRef[] {
  if (!Array.isArray(raw)) return [];
  const out: VisionImageRef[] = [];

  for (const row of raw) {
    if (out.length >= MAX_VISION_IMAGES) break;
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const url = sanitizeImageUrl(o.url);
    const captionRaw = typeof o.caption === "string" ? o.caption.trim() : "";
    const caption = captionRaw ? captionRaw.slice(0, 280) : "Board image";
    if (url && isSupportedVisionImageUrl(url)) out.push({ caption, url });
  }

  return out;
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey?.trim()) {
      return NextResponse.json(
        { error: "Add OPENAI_API_KEY to enable the AI assistant." },
        { status: 503 },
      );
    }

    const body: unknown = await request.json();

    let rawContext = "";
    let historyPayload: ChatPiece[] = [];
    let visionRefs: VisionImageRef[] = [];

    if (body && typeof body === "object" && !Array.isArray(body)) {
      const b = body as Record<string, unknown>;
      rawContext = typeof b.context === "string" ? b.context : "";

      const h = b.history;
      if (Array.isArray(h)) {
        historyPayload = h as ChatPiece[];
      }

      visionRefs = parseVisionImages(b.visionImages);
    }

    const messages: ChatApiMessage[] = [
      {
        role: "system",
        content: `${SYSTEM_PREFIX}\n\n${rawContext}`,
      },
    ];

    const safeHistory = historyPayload
      .filter(
        (m): m is ChatPiece =>
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim().length > 0,
      )
      .slice(-20);

    let totalApprox = JSON.stringify(messages[0]).length;
    const MAX_CONTEXT_CHARS = 95_000;
    const kept: ChatPiece[] = [];

    for (let i = safeHistory.length - 1; i >= 0; i--) {
      const piece = safeHistory[i];
      if (!piece) continue;
      const add = piece.content.length + 48;
      if (totalApprox + add > MAX_CONTEXT_CHARS) break;
      kept.unshift(piece);
      totalApprox += add;
    }

    const prefix = kept.length > 1 ? kept.slice(0, -1) : [];
    const last = kept.length > 0 ? kept[kept.length - 1] : undefined;

    for (const m of prefix) {
      messages.push({ role: m.role, content: m.content });
    }

    if (last) {
      if (last.role === "user" && visionRefs.length > 0) {
        const multimodalParts: MsgContentPart[] = [
          {
            type: "text",
            text:
              "Reference images follow. Each caption is the board slot (month · category · item). Read covers/stills visually; map them to titles when readability allows.\n",
          },
        ];

        for (const img of visionRefs) {
          multimodalParts.push({
            type: "text",
            text: `\n${img.caption}`,
          });
          multimodalParts.push({
            type: "image_url",
            image_url: {
              url: img.url,
              detail: "low",
            },
          });
        }

        multimodalParts.push({
          type: "text",
          text: `\nLatest user question (answer this in light of conversation + images):\n${last.content}`,
        });

        messages.push({ role: "user", content: multimodalParts });
      } else {
        messages.push({ role: last.role, content: last.content });
      }
    }

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.72,
        max_tokens: 1100,
        messages,
      }),
    });

    const data: OpenAiChatResponse = (await res.json()) as OpenAiChatResponse;

    if (!res.ok) {
      const detail = data.error ?? JSON.stringify(data);
      console.error("OpenAI chat error:", detail);
      return NextResponse.json(
        { error: "The model API returned an error. Check your quota and OPENAI_MODEL (vision needs a vision-capable model)." },
        { status: 502 },
      );
    }

    const choice = data.choices?.[0];
    const raw = choice?.message?.content;

    let text =
      typeof raw === "string"
        ? raw.trim()
        : Array.isArray(raw)
          ? raw
              .map((chunk) =>
                chunk && typeof chunk === "object" && "text" in chunk ? String(chunk.text) : "",
              )
              .join("")
              .trim()
          : "";

    if (!text && raw != null) {
      text = String(raw).trim();
    }

    if (!text) {
      return NextResponse.json({ error: "Empty model reply." }, { status: 502 });
    }

    return NextResponse.json({ reply: text });
  } catch (e) {
    console.error("ai-chat route:", e);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { openLibraryUserAgent } from "../../../lib/open-library-user-agent";

export type OpenLibrarySearchHit = {
  work_key: string;
  title: string;
  author_name: string[];
  cover_i: number | null;
  first_publish_year: number | null;
};

function parseWorkKey(key: unknown): string | null {
  if (typeof key !== "string" || !key.startsWith("/works/")) return null;
  const id = key.slice("/works/".length);
  if (!/^[A-Za-z0-9]+$/.test(id)) return null;
  return id;
}

function parseDoc(row: unknown): OpenLibrarySearchHit | null {
  if (!row || typeof row !== "object") return null;
  const o = row as Record<string, unknown>;
  const work_key = parseWorkKey(o.key);
  const title = typeof o.title === "string" ? o.title.trim() : "";
  if (!work_key || !title) return null;

  let author_name: string[] = [];
  if (Array.isArray(o.author_name)) {
    author_name = o.author_name.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
  }

  let cover_i: number | null = null;
  if (typeof o.cover_i === "number" && Number.isFinite(o.cover_i) && o.cover_i > 0) {
    cover_i = Math.floor(o.cover_i);
  }

  let first_publish_year: number | null = null;
  if (typeof o.first_publish_year === "number" && Number.isFinite(o.first_publish_year)) {
    first_publish_year = Math.floor(o.first_publish_year);
  }

  return { work_key, title, author_name, cover_i, first_publish_year };
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
  }

  const limit = Math.min(20, Math.max(1, Number(request.nextUrl.searchParams.get("limit") ?? "15") || 15));
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));

  const headers: HeadersInit = {
    Accept: "application/json",
    "User-Agent": openLibraryUserAgent(),
  };

  let upstream: Response;
  try {
    upstream = await fetch(url.toString(), { headers, next: { revalidate: 0 } });
  } catch (e) {
    console.error("Open Library search fetch failed", e);
    return NextResponse.json({ error: "Open Library search failed." }, { status: 502 });
  }

  if (!upstream.ok) {
    console.error("Open Library search HTTP", upstream.status);
    return NextResponse.json({ error: "Open Library search failed." }, { status: 502 });
  }

  let docs: unknown[] = [];
  try {
    const data = (await upstream.json()) as { docs?: unknown[] };
    docs = Array.isArray(data.docs) ? data.docs : [];
  } catch {
    return NextResponse.json({ error: "Invalid Open Library response." }, { status: 502 });
  }

  const results: OpenLibrarySearchHit[] = [];
  for (const row of docs) {
    const hit = parseDoc(row);
    if (hit) results.push(hit);
  }

  return NextResponse.json({ results });
}

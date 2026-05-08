import { NextRequest, NextResponse } from "next/server";

const TMDB_BASE = "https://api.themoviedb.org/3";

type TmdbSearchResultItem = {
  id: number;
  media_type: "movie" | "tv";
  title: string;
  /** `release_date` for movies; `first_air_date` for TV (YYYY-MM-DD or empty). */
  release_date: string;
  poster_path: string | null;
};

type ParsedHit = TmdbSearchResultItem & { popularity: number };

function buildSearchUrl(kind: "movie" | "tv", q: string, apiKey: string | undefined) {
  const path = kind === "movie" ? "/search/movie" : "/search/tv";
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("query", q);
  url.searchParams.set("page", "1");
  url.searchParams.set("include_adult", "false");
  if (apiKey) url.searchParams.set("api_key", apiKey);
  return url;
}

function parseMovie(row: unknown): ParsedHit | null {
  if (!row || typeof row !== "object") return null;
  const o = row as Record<string, unknown>;
  const id = typeof o.id === "number" && Number.isFinite(o.id) ? o.id : null;
  const title = typeof o.title === "string" ? o.title : "";
  if (id === null || !title.trim()) return null;
  const release_date = typeof o.release_date === "string" ? o.release_date : "";
  const poster_path =
    typeof o.poster_path === "string" && o.poster_path.startsWith("/")
      ? o.poster_path
      : null;
  const popularity = typeof o.popularity === "number" && Number.isFinite(o.popularity) ? o.popularity : 0;
  return { id, media_type: "movie", title, release_date, poster_path, popularity };
}

function parseTv(row: unknown): ParsedHit | null {
  if (!row || typeof row !== "object") return null;
  const o = row as Record<string, unknown>;
  const id = typeof o.id === "number" && Number.isFinite(o.id) ? o.id : null;
  const title = typeof o.name === "string" ? o.name : "";
  if (id === null || !title.trim()) return null;
  const release_date =
    typeof o.first_air_date === "string" ? o.first_air_date : "";
  const poster_path =
    typeof o.poster_path === "string" && o.poster_path.startsWith("/")
      ? o.poster_path
      : null;
  const popularity = typeof o.popularity === "number" && Number.isFinite(o.popularity) ? o.popularity : 0;
  return { id, media_type: "tv", title, release_date, poster_path, popularity };
}

export async function GET(request: NextRequest) {
  const readToken = process.env.TMDB_READ_ACCESS_TOKEN?.trim();
  const apiKey = process.env.TMDB_API_KEY?.trim();

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
  }

  if (!readToken && !apiKey) {
    return NextResponse.json(
      { error: "Set TMDB_API_KEY or TMDB_READ_ACCESS_TOKEN." },
      { status: 503 },
    );
  }

  const headers: HeadersInit = { Accept: "application/json" };
  if (readToken) headers.Authorization = `Bearer ${readToken}`;

  const movieUrl = buildSearchUrl("movie", q, readToken ? undefined : apiKey);
  const tvUrl = buildSearchUrl("tv", q, readToken ? undefined : apiKey);

  const [movieRes, tvRes] = await Promise.all([
    fetch(movieUrl.toString(), { headers, next: { revalidate: 0 } }),
    fetch(tvUrl.toString(), { headers, next: { revalidate: 0 } }),
  ]);

  const errors: string[] = [];
  let movieRows: unknown[] = [];
  let tvRows: unknown[] = [];

  if (movieRes.ok) {
    try {
      const data = (await movieRes.json()) as { results?: unknown[] };
      movieRows = Array.isArray(data.results) ? data.results : [];
    } catch {
      errors.push("movie");
    }
  } else {
    errors.push("movie");
  }

  if (tvRes.ok) {
    try {
      const data = (await tvRes.json()) as { results?: unknown[] };
      tvRows = Array.isArray(data.results) ? data.results : [];
    } catch {
      errors.push("tv");
    }
  } else {
    errors.push("tv");
  }

  if (errors.length === 2) {
    console.error("TMDB dual search failed", movieRes.status, tvRes.status);
    return NextResponse.json({ error: "TMDB search failed." }, { status: 502 });
  }

  const combined: ParsedHit[] = [];

  for (const row of movieRows) {
    const hit = parseMovie(row);
    if (hit) combined.push(hit);
  }
  for (const row of tvRows) {
    const hit = parseTv(row);
    if (hit) combined.push(hit);
  }

  combined.sort((a, b) => b.popularity - a.popularity);

  const results: TmdbSearchResultItem[] = combined.slice(0, 20).map(({ popularity: _p, ...rest }) => rest);

  return NextResponse.json({ results });
}

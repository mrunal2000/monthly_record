import { NextRequest, NextResponse } from "next/server";
import { nominatimContactEmail, nominatimUserAgent } from "../../../lib/nominatim-user-agent";

type NominatimSearchHit = {
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  class: string;
  type: string;
  /** From OSM `image` / `wikimedia_commons` extratags when available; otherwise null. */
  thumb_url: string | null;
};

function wikimediaCommonsThumbUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const file = trimmed.replace(/^File:/i, "").trim();
  if (!file) return null;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=128`;
}

function thumbUrlFromExtratags(ex: unknown): string | null {
  if (!ex || typeof ex !== "object") return null;
  const e = ex as Record<string, unknown>;
  const pick = (k: string): string => {
    const v = e[k];
    return typeof v === "string" ? v.trim() : "";
  };

  const image = pick("image");
  if (image.startsWith("https://") || image.startsWith("http://")) {
    try {
      const u = new URL(image);
      if (u.protocol === "http:" || u.protocol === "https:") return image;
    } catch {
      return null;
    }
  }
  if (/^file:/i.test(image)) {
    return wikimediaCommonsThumbUrl(image);
  }

  const commons = pick("wikimedia_commons") || pick("image:wikimedia_commons");
  if (commons) return wikimediaCommonsThumbUrl(commons);

  return null;
}

function parseHit(row: unknown): NominatimSearchHit | null {
  if (!row || typeof row !== "object") return null;
  const o = row as Record<string, unknown>;
  const osm_type = typeof o.osm_type === "string" ? o.osm_type.toLowerCase() : "";
  const osm_id = typeof o.osm_id === "number" && Number.isFinite(o.osm_id) ? Math.trunc(o.osm_id) : null;
  const lat = typeof o.lat === "string" ? o.lat : "";
  const lon = typeof o.lon === "string" ? o.lon : "";
  const display_name = typeof o.display_name === "string" ? o.display_name.trim() : "";
  const cls = typeof o.class === "string" ? o.class : "";
  const typ = typeof o.type === "string" ? o.type : "";
  if (!osm_type || osm_id == null || osm_id <= 0 || !display_name) return null;
  if (osm_type !== "node" && osm_type !== "way" && osm_type !== "relation") return null;

  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : undefined;
  const thumb_url = thumbUrlFromExtratags(o.extratags);
  return {
    osm_type,
    osm_id,
    lat: lat || "0",
    lon: lon || "0",
    display_name,
    name,
    class: cls,
    type: typ,
    thumb_url,
  };
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("limit", "12");
  /** Prefer points of interest (restaurants, cafés, etc.) over streets and admin areas. */
  url.searchParams.set("layer", "poi");
  const email = nominatimContactEmail();
  if (email) url.searchParams.set("email", email);

  const headers = new Headers({
    Accept: "application/json",
    "User-Agent": nominatimUserAgent(),
    "Accept-Language": "en",
  });

  let upstream: Response;
  try {
    upstream = await fetch(url.toString(), {
      headers,
      next: { revalidate: 3600 },
    });
  } catch (e) {
    console.error("Nominatim search fetch failed", e);
    return NextResponse.json({ error: "Nominatim search failed." }, { status: 502 });
  }

  if (!upstream.ok) {
    console.error("Nominatim search HTTP", upstream.status);
    return NextResponse.json({ error: "Nominatim search failed." }, { status: 502 });
  }

  let rows: unknown[] = [];
  try {
    const data = (await upstream.json()) as unknown;
    rows = Array.isArray(data) ? data : [];
  } catch {
    return NextResponse.json({ error: "Invalid Nominatim response." }, { status: 502 });
  }

  const results: NominatimSearchHit[] = [];
  for (const row of rows) {
    const hit = parseHit(row);
    if (hit) results.push(hit);
  }

  return NextResponse.json({ results });
}

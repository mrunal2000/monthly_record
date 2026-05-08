import { NextRequest, NextResponse } from "next/server";

/** Avoid open proxies: only TMDB poster filenames on the CDN. */
const ALLOWED_SIZES = new Set(["w185", "w342", "w500", "w780", "original"]);
const POSTER_PATH = /^\/[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png|webp)$/i;

export async function GET(request: NextRequest) {
  const size = request.nextUrl.searchParams.get("size") ?? "w500";
  const poster = request.nextUrl.searchParams.get("poster")?.trim() ?? "";

  if (!ALLOWED_SIZES.has(size)) {
    return NextResponse.json({ error: "Invalid image size." }, { status: 400 });
  }
  if (!POSTER_PATH.test(poster)) {
    return NextResponse.json({ error: "Invalid poster path." }, { status: 400 });
  }

  const upstreamUrl = `https://image.tmdb.org/t/p/${size}${poster}`;
  const upstream = await fetch(upstreamUrl, { next: { revalidate: 86_400 } });

  if (!upstream.ok) {
    return NextResponse.json({ error: "Could not load poster." }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") || "image/jpeg";

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
}

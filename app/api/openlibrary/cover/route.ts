import { NextRequest, NextResponse } from "next/server";
import { openLibraryUserAgent } from "../../../lib/open-library-user-agent";

const ALLOWED_SIZES = new Set(["S", "M", "L"]);

export async function GET(request: NextRequest) {
  const rawId = request.nextUrl.searchParams.get("id")?.trim() ?? "";
  const size = (request.nextUrl.searchParams.get("size") ?? "L").toUpperCase();

  if (!ALLOWED_SIZES.has(size)) {
    return NextResponse.json({ error: "Invalid cover size (use S, M, or L)." }, { status: 400 });
  }

  if (!/^\d+$/.test(rawId)) {
    return NextResponse.json({ error: "Invalid cover id." }, { status: 400 });
  }
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid cover id." }, { status: 400 });
  }

  const upstreamUrl = `https://covers.openlibrary.org/b/id/${id}-${size}.jpg`;
  const upstream = await fetch(upstreamUrl, {
    headers: { "User-Agent": openLibraryUserAgent() },
    next: { revalidate: 86_400 },
  });

  if (!upstream.ok) {
    return NextResponse.json({ error: "Could not load cover." }, { status: 502 });
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

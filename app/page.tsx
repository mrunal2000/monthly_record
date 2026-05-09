"use client";

import type { CSSProperties, ChangeEvent, FormEvent, PointerEvent } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { User } from "@supabase/supabase-js";

/** Supabase rejects bursts of OTP / magic-link emails (429); map for clearer UI. */
function isEmailSendRateLimited(
  status: unknown,
  message?: string | null,
  code?: string | null,
) {
  if (typeof status === "number" && status === 429) return true;
  const blob = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  return (
    blob.includes("rate limit") ||
    blob.includes("rate_limit") ||
    blob.includes("over_email_send") ||
    blob.includes("too many")
  );
}
import FavoritesAiAgent from "./components/FavoritesAiAgent";
import { normalizeImageFileForStorage } from "./lib/normalizeUploadImage";
import { BOARD_TEXT_TABLE, FAVORITES_BUCKET, FAVORITES_TABLE, supabase } from "./lib/supabase";

type BoardVariant = "canvas" | "links" | "quotes";

type Category = {
  id: string;
  label: string;
  note: string;
  color: string;
  textColor: string;
  variant?: BoardVariant;
};

type LinkEntry = {
  id: string;
  url: string;
  title: string;
  note: string;
  /** Preview image when saved from OSM (Nominatim extratags). */
  thumbUrl?: string;
  /** Local / client time; used for ${year} overview. Server rows infer from created_at when loading. */
  addedAtMs?: number;
};

type QuoteEntry = {
  id: string;
  text: string;
  source: string;
  addedAtMs?: number;
};

type TmdbSearchHit = {
  id: number;
  media_type: "movie" | "tv";
  title: string;
  release_date: string;
  poster_path: string | null;
};

function tmdbHitBusyKey(hit: TmdbSearchHit) {
  return `${hit.media_type}-${hit.id}`;
}

const CATEGORIES_STORAGE_KEY = "monthly-record-categories";
const LINKS_STORAGE_KEY = "monthly-record-board-links";
const QUOTES_STORAGE_KEY = "monthly-record-board-quotes";

/** TMDB posters always land on the canonical media board (same month as the active collage). */
const TMDB_MEDIA_CATEGORY_ID = "media";

/** Open Library covers land on the canonical books board. */
const OPEN_LIBRARY_BOOKS_CATEGORY_ID = "books";

/** OSM / Nominatim place links land on the canonical restaurants board (links variant). */
const RESTAURANTS_NOMINATIM_CATEGORY_ID = "restaurants";

/** When `"1"`, allow editing without signing in; data stays in this browser (links/quotes persist; images use blob URLs until you sign in). Do not enable on a public production deployment. */
const ALLOW_LOCAL_EDIT_WITHOUT_AUTH =
  process.env.NEXT_PUBLIC_ALLOW_LOCAL_EDIT_WITHOUT_AUTH === "1";

const DEFAULT_CATEGORIES: Category[] = [
  {
    id: "media",
    label: "MEDIA",
    note: "Add stills, posters, scenes, and anything from what you watched.",
    color: "var(--category-media)",
    textColor: "var(--category-on-dark)",
  },
  {
    id: "books",
    label: "BOOKS",
    note: "Add covers, spreads, quotes, and references you want to arrange.",
    color: "var(--category-books)",
    textColor: "var(--category-on-dark)",
  },
  {
    id: "misc",
    label: "MISC",
    note: "Add anything that does not fit neatly anywhere else.",
    color: "var(--category-misc)",
    textColor: "var(--category-on-dark)",
  },
  {
    id: "wishlist",
    label: "WISHLIST",
    note: "Add things you want, are considering, or want to remember.",
    color: "var(--category-wishlist)",
    textColor: "var(--category-on-light)",
  },
  {
    id: "restaurants",
    label: "Restaurants",
    note: "Search for a place, then save an OpenStreetMap link to that spot.",
    color: "var(--category-restaurants)",
    textColor: "var(--category-on-dark)",
    variant: "links",
  },
  {
    id: "rabbit-holes",
    label: "Links",
    note: "Save URLs to revisit — articles, threads, repos, and clips.",
    color: "var(--category-rabbit)",
    textColor: "var(--category-on-dark)",
    variant: "links",
  },
  {
    id: "quotes",
    label: "QUOTES",
    note: "Short lines worth keeping — overheard, read, highlighted.",
    color: "var(--category-quotes)",
    textColor: "var(--category-on-dark)",
    variant: "quotes",
  },
];

/** Stored titles from older defaults before the links frame used sentence case. */
const LEGACY_RABBIT_HOLES_LABELS = new Set([
  "RABBIT HOLES",
  "Rabbit holes",
  "Rabbit Holes",
  "rabbit holes",
  "LINKS",
]);

function upgradeLegacyLinksFrameCategories(categories: Category[]): Category[] {
  const def = DEFAULT_CATEGORIES.find((c) => c.id === "rabbit-holes");
  if (!def) return categories;
  return categories.map((cat) => {
    if (cat.id !== "rabbit-holes") return cat;
    if (!LEGACY_RABBIT_HOLES_LABELS.has(cat.label)) return cat;
    return { ...cat, label: def.label, note: def.note };
  });
}

/** Default frame was all-caps before switching to sentence case. */
function upgradeLegacyRestaurantsLabels(categories: Category[]): Category[] {
  const def = DEFAULT_CATEGORIES.find((c) => c.id === RESTAURANTS_NOMINATIM_CATEGORY_ID);
  if (!def) return categories;
  return categories.map((cat) => {
    if (cat.id !== RESTAURANTS_NOMINATIM_CATEGORY_ID) return cat;
    if (cat.label !== "RESTAURANTS") return cat;
    return { ...cat, label: def.label, note: cat.note || def.note };
  });
}

type CanvasImage = {
  id: string;
  src: string;
  storagePath?: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
  /** Set on upload; synced from Supabase created_at when present. Items without date still appear in the year overview (legacy). */
  addedAtMs?: number;
  /** TMDB poster import — opens https://www.themoviedb.org/movie|tv/{id} (also inferred from storage_path when missing). */
  tmdbId?: number;
  tmdbMediaType?: "movie" | "tv";
  /** Open Library cover import — work id for https://openlibrary.org/works/{key} (also inferred from storage_path). */
  openLibraryWorkKey?: string;
  openLibraryCoverId?: number;
};

/** Full-AR hover card for year grid; `position: fixed` so scroll parents don’t clip it. */
type YearMediaHoverPeek = {
  src: string;
  cx: number;
  anchorPx: number;
  placement: "above" | "below";
};

type FavoriteItemRow = {
  id: string;
  board_key: string;
  month_id: string;
  category_index: number;
  category_label: string;
  image_url: string | null;
  storage_path: string | null;
  x: number;
  y: number;
  width: number;
  rotation: number;
  created_at?: string | null;
};

type DragState = {
  mode: "move" | "resize";
  imageKey: string;
  imageId: string;
  offsetX: number;
  offsetY: number;
  element: HTMLElement;
  pointerId: number;
  canvasEl: HTMLElement;
  /** Undo document touchmove blocker (mobile scroll steals drag gestures otherwise). */
  scrollGuardUnload?: () => void;
  /** iOS/Safari: pointermove/up on the node under capture is unreliable — route from window. */
  windowPointerUnload?: () => void;
};

/** Prevent the page (`main.page`) from scrolling mid-gesture — `touch-action: none` is not reliable on nested iOS/Safari. */
function installCanvasDragScrollGuard(): () => void {
  if (typeof document === "undefined") return () => {};
  const opts = { capture: true, passive: false } as const;
  const blockTouchMove = (e: TouchEvent) => {
    e.preventDefault();
  };
  document.addEventListener("touchmove", blockTouchMove as EventListener, opts);
  return () => document.removeEventListener("touchmove", blockTouchMove as EventListener, opts);
}

/** Route pointer stream from `window` so touch drags still receive move/end on iOS WebKit (element capture alone is flaky). */
function installCanvasWindowPointerRouting(
  pointerId: number,
  onMove: (clientX: number, clientY: number) => void,
  onEnd: (clientX: number, clientY: number, cancelled: boolean) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const opts = { capture: true } as const;
  const move = (evt: Event) => {
    const e = evt instanceof globalThis.PointerEvent ? evt : null;
    if (!e || e.pointerId !== pointerId) return;
    if (e.pointerType === "touch") {
      e.preventDefault();
    }
    onMove(e.clientX, e.clientY);
  };
  const end = (evt: Event) => {
    const e = evt instanceof globalThis.PointerEvent ? evt : null;
    if (!e || e.pointerId !== pointerId) return;
    if (e.pointerType === "touch") {
      e.preventDefault();
    }
    const cancelled = evt.type === "pointercancel";
    onEnd(e.clientX, e.clientY, cancelled);
  };
  window.addEventListener("pointermove", move, opts);
  window.addEventListener("pointerup", end, opts);
  window.addEventListener("pointercancel", end, opts);
  return () => {
    window.removeEventListener("pointermove", move, opts);
    window.removeEventListener("pointerup", end, opts);
    window.removeEventListener("pointercancel", end, opts);
  };
}

type ThemeName = "paper" | "brutalist" | "minimal";
type OpenDirection = "ltr" | "rtl";

const themes: { id: ThemeName; label: string }[] = [
  { id: "paper", label: "PAPER" },
  { id: "brutalist", label: "BRUTALIST" },
  { id: "minimal", label: "MINIMAL" },
];

const months = [
  { id: "jan", label: "JAN" },
  { id: "feb", label: "FEB" },
  { id: "mar", label: "MAR" },
  { id: "apr", label: "APR" },
  { id: "may", label: "MAY" },
  { id: "jun", label: "JUN" },
  { id: "jul", label: "JUL" },
  { id: "aug", label: "AUG" },
  { id: "sep", label: "SEP" },
  { id: "oct", label: "OCT" },
  { id: "nov", label: "NOV" },
  { id: "dec", label: "DEC" },
];

/** Extra rail slot after December: aggregated calendar-year overview (index === months.length). */
const YEAR_OVERVIEW_SLOT_INDEX = months.length;
/** Year MEDIA recap: tight grid of cells (design: 10 cols × N rows, min 6 rows). */
const YEAR_MEDIA_GRID_COLUMNS = 10;
const YEAR_MEDIA_GRID_MIN_ROWS = 6;

/**
 * Matches the **placed** grid: some engines report `repeat()` as a single token; counting
 * first-row siblings by geometry matches shrink-wrapped tracks (mobile `auto-fill`, etc.).
 */
function readYearMediaGridColumnCount(grid: HTMLElement): number {
  const children = [...grid.children].filter((n): n is HTMLElement => n instanceof HTMLElement);
  if (children.length === 0) return YEAR_MEDIA_GRID_COLUMNS;

  const topRef = children[0].getBoundingClientRect().top;
  const rowTolerancePx = 2;

  let byRow = 0;
  for (const cell of children) {
    const t = cell.getBoundingClientRect().top;
    if (byRow > 0 && Math.abs(t - topRef) > rowTolerancePx) break;
    byRow++;
  }
  if (byRow > 0) return byRow;

  const tpl = getComputedStyle(grid).gridTemplateColumns.trim();
  if (!tpl || tpl === "none") return YEAR_MEDIA_GRID_COLUMNS;
  const parts = tpl.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts.length : YEAR_MEDIA_GRID_COLUMNS;
}

function belongsInOverviewYear(addedAtMs: number | undefined, overviewYear: number): boolean {
  if (addedAtMs === undefined) return true;
  return new Date(addedAtMs).getFullYear() === overviewYear;
}

/** TMDB allows public links to title pages; we match imports saved as `…tmdb-movie-123-…` / `…tmdb-tv-456-…`. */
function parseTmdbFromStoragePath(storagePath?: string | null): {
  tmdbId: number;
  tmdbMediaType: "movie" | "tv";
} | null {
  if (!storagePath) return null;
  const m = storagePath.match(/tmdb-(movie|tv)-(\d+)-/i);
  if (!m) return null;
  const id = Number.parseInt(m[2], 10);
  if (!Number.isFinite(id)) return null;
  const tmdbMediaType = m[1].toLowerCase() === "tv" ? "tv" : "movie";
  return { tmdbId: id, tmdbMediaType };
}

function tmdbPageUrlForImage(image: CanvasImage): string | null {
  let tmdbId = image.tmdbId;
  let tmdbMediaType = image.tmdbMediaType;
  if (tmdbId == null || (tmdbMediaType !== "movie" && tmdbMediaType !== "tv")) {
    const parsed = parseTmdbFromStoragePath(image.storagePath);
    if (!parsed) return null;
    tmdbId = parsed.tmdbId;
    tmdbMediaType = parsed.tmdbMediaType;
  }
  const slug = tmdbMediaType === "tv" ? "tv" : "movie";
  return `https://www.themoviedb.org/${slug}/${tmdbId}`;
}

/** Imports saved as `…openlib-work-OL45804W-…` (work OLID from Open Library). */
function parseOpenLibraryFromStoragePath(storagePath?: string | null): {
  openLibraryWorkKey: string;
} | null {
  if (!storagePath) return null;
  const m = storagePath.match(/openlib-work-([A-Za-z0-9]+)-/i);
  if (!m) return null;
  return { openLibraryWorkKey: m[1] };
}

function openLibraryPageUrlForImage(image: CanvasImage): string | null {
  let workKey = image.openLibraryWorkKey;
  if (!workKey) {
    const parsed = parseOpenLibraryFromStoragePath(image.storagePath);
    workKey = parsed?.openLibraryWorkKey;
  }
  if (!workKey) return null;
  return `https://openlibrary.org/works/${workKey}`;
}

function catalogExternalPageForImage(
  image: CanvasImage,
  theme: ThemeName,
): {
  href: string;
  source: "tmdb" | "openLibrary";
  lightboxLabel: string;
} | null {
  const tmdb = tmdbPageUrlForImage(image);
  if (tmdb) {
    return {
      href: tmdb,
      source: "tmdb",
      lightboxLabel: theme === "minimal" ? "Open on TMDB" : "OPEN ON TMDB",
    };
  }
  const ol = openLibraryPageUrlForImage(image);
  if (!ol) return null;
  return {
    href: ol,
    source: "openLibrary",
    lightboxLabel: theme === "minimal" ? "Open on Open Library" : "OPEN ON OPEN LIBRARY",
  };
}

function catalogExternalLinkAriaLabel(source: "tmdb" | "openLibrary", theme: ThemeName) {
  if (source === "tmdb") {
    return theme === "minimal" ? "Open on TMDB (new tab)" : "OPEN ON TMDB (NEW TAB)";
  }
  return theme === "minimal"
    ? "Open on Open Library (new tab)"
    : "OPEN ON OPEN LIBRARY (NEW TAB)";
}

type OpenLibrarySearchHit = {
  work_key: string;
  title: string;
  author_name: string[];
  cover_i: number | null;
  first_publish_year: number | null;
};

function openLibraryHitBusyKey(hit: OpenLibrarySearchHit) {
  return `${hit.work_key}-${hit.cover_i ?? "nocover"}`;
}

type NominatimSearchHit = {
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  class: string;
  type: string;
  thumb_url: string | null;
};

function nominatimHitBusyKey(hit: NominatimSearchHit) {
  return `${hit.osm_type}-${hit.osm_id}`;
}

function osmBrowseUrl(hit: NominatimSearchHit): string {
  return `https://www.openstreetmap.org/${hit.osm_type}/${hit.osm_id}`;
}

function placeTitleFromNominatimHit(hit: NominatimSearchHit): string {
  if (hit.name?.trim()) return hit.name.trim();
  const first = hit.display_name.split(",")[0]?.trim();
  return first || hit.display_name;
}

function mergeImagesForYearCategory(
  boards: Record<string, CanvasImage[]>,
  categoryId: string,
  monthIds: readonly string[],
  overviewYear: number,
): CanvasImage[] {
  const byId = new Map<string, CanvasImage>();
  for (const monthId of monthIds) {
    const key = `${monthId}-${categoryId}`;
    for (const img of boards[key] ?? []) {
      if (!belongsInOverviewYear(img.addedAtMs, overviewYear)) continue;
      byId.set(img.id, img);
    }
  }
  return [...byId.values()];
}

function mergeLinksForYearCategory(
  boards: Record<string, LinkEntry[]>,
  categoryId: string,
  monthIds: readonly string[],
  overviewYear: number,
): LinkEntry[] {
  const byId = new Map<string, LinkEntry>();
  for (const monthId of monthIds) {
    const key = `${monthId}-${categoryId}`;
    for (const e of boards[key] ?? []) {
      if (!belongsInOverviewYear(e.addedAtMs, overviewYear)) continue;
      byId.set(e.id, e);
    }
  }
  return [...byId.values()];
}

function mergeQuotesForYearCategory(
  boards: Record<string, QuoteEntry[]>,
  categoryId: string,
  monthIds: readonly string[],
  overviewYear: number,
): QuoteEntry[] {
  const byId = new Map<string, QuoteEntry>();
  for (const monthId of monthIds) {
    const key = `${monthId}-${categoryId}`;
    for (const e of boards[key] ?? []) {
      if (!belongsInOverviewYear(e.addedAtMs, overviewYear)) continue;
      byId.set(e.id, e);
    }
  }
  return [...byId.values()];
}

/** Title-case month id for MINIMAL rail (horizontal, non-all-caps). */
function formatMonthNavLabel(monthId: string) {
  if (!monthId) return "";
  return monthId.charAt(0).toUpperCase() + monthId.slice(1).toLowerCase();
}

/** Sentence case for minimal theme frame titles (e.g. MEDIA → Media). */
function formatMinimalSentenceCase(label: string) {
  const t = label.trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function wrapIndex(index: number, length: number) {
  if (length <= 0) return 0;
  const mod = index % length;
  return mod < 0 ? mod + length : mod;
}

function shortestSignedDistance(from: number, to: number, length: number) {
  if (length <= 1) return 0;
  let delta = to - from;
  const half = Math.floor(length / 2);
  if (delta > half) delta -= length;
  if (delta < -half) delta += length;
  return delta;
}

/** Paper / brutalist default to ALL CAPS on blur; links boards keep sentence case. */
function normalizeFrameTitleOnBlur(raw: string, theme: ThemeName, categoryId: string) {
  const t = raw.trim();
  if (!t) return t;
  if (
    theme === "minimal" ||
    categoryId === "rabbit-holes" ||
    categoryId === RESTAURANTS_NOMINATIM_CATEGORY_ID
  ) {
    return formatMinimalSentenceCase(t);
  }
  return t.toUpperCase();
}

/** Timestamp for minimal: mixed case (not all-caps), lowercase am/pm. */
function formatMinimalTimestamp(date: Date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  return dtf
    .formatToParts(date)
    .map(({ type, value }) => {
      if (type === "dayPeriod") return value.toLowerCase();
      if (type === "literal") return value;
      return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    })
    .join("");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Keep pointer math inside the canvas so a finger dragged off-screen does not map to 100% width / wild %. */
function clampClientPointToCanvas(clientX: number, clientY: number, canvas: DOMRect) {
  return {
    cx: clamp(clientX, canvas.left, canvas.right),
    cy: clamp(clientY, canvas.top, canvas.bottom),
  };
}

function getCurrentMonthIndex() {
  return new Date().getMonth();
}

function canonicalBoardKey(boardKey: string) {
  const dash = boardKey.indexOf("-");
  if (dash === -1) return boardKey;
  const monthId = boardKey.slice(0, dash);
  const tail = boardKey.slice(dash + 1);
  if (/^\d+$/.test(tail)) {
    const idx = Number.parseInt(tail, 10);
    const def = DEFAULT_CATEGORIES[idx];
    if (def) return `${monthId}-${def.id}`;
  }
  return boardKey;
}

/** Legacy board keys used `food`; default frame is now `restaurants`. */
function remapBoardKeyFoodToRestaurants(boardKey: string): string {
  return boardKey.replace(/-food$/, "-restaurants");
}

function upgradeFoodCategoryToRestaurants(categories: Category[]): Category[] {
  const def = DEFAULT_CATEGORIES.find((c) => c.id === RESTAURANTS_NOMINATIM_CATEGORY_ID);
  const out: Category[] = [];
  let hasRestaurants = false;
  for (const c of categories) {
    if (c.id === "food") {
      hasRestaurants = true;
      out.push({
        ...c,
        id: RESTAURANTS_NOMINATIM_CATEGORY_ID,
        label: def?.label ?? "Restaurants",
        note: def?.note ?? c.note,
        color: def?.color ?? "var(--category-restaurants)",
        textColor: def?.textColor ?? c.textColor,
        variant: "links",
      });
      continue;
    }
    if (c.id === RESTAURANTS_NOMINATIM_CATEGORY_ID) {
      if (hasRestaurants) continue;
      hasRestaurants = true;
      out.push({
        ...c,
        variant: "links",
        color: def?.color ?? c.color,
        textColor: def?.textColor ?? c.textColor,
      });
      continue;
    }
    out.push(c);
  }
  return out;
}

function categoryIdFromBoardKey(boardKey: string) {
  const dash = boardKey.indexOf("-");
  if (dash === -1) return "";
  return boardKey.slice(dash + 1);
}

function mergeTextBoardsById<T extends { id: string }>(
  local: Record<string, T[]>,
  remote: Record<string, T[]>,
): Record<string, T[]> {
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const out: Record<string, T[]> = {};
  for (const k of keys) {
    const byId = new Map<string, T>();
    for (const e of local[k] ?? []) byId.set(e.id, e);
    for (const e of remote[k] ?? []) byId.set(e.id, e);
    out[k] = Array.from(byId.values());
  }
  return out;
}

function normalizeUrlInput(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  try {
    const u = /^https?:\/\//i.test(t) ? new URL(t) : new URL(`https://${t}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function linkHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function linkDisplayHeading(url: string, customTitle: string): string {
  const t = customTitle.trim();
  if (t) return t;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "");
    const path = u.pathname.replace(/\/$/, "") || "";
    return path && path !== "/" ? `${host}${path}` : host;
  } catch {
    return url;
  }
}

function parseLinksFromStorage(raw: string | null): Record<string, LinkEntry[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, LinkEntry[]> = {};
    for (const [boardKey, rows] of Object.entries(parsed)) {
      if (!boardKey.trim() || !Array.isArray(rows)) continue;
      out[boardKey] = rows
        .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
        .map((row) => ({
          id: typeof row.id === "string" && row.id.trim() ? row.id : crypto.randomUUID(),
          url: typeof row.url === "string" ? row.url : "",
          title: typeof row.title === "string" ? row.title : "",
          note: typeof row.note === "string" ? row.note : "",
          thumbUrl:
            typeof row.thumbUrl === "string" && row.thumbUrl.trim()
              ? row.thumbUrl.trim()
              : undefined,
          addedAtMs: typeof row.addedAtMs === "number" && Number.isFinite(row.addedAtMs) ? row.addedAtMs : undefined,
        }))
        .filter((e) => e.url.trim());
    }
    const merged: Record<string, LinkEntry[]> = {};
    for (const [k, list] of Object.entries(out)) {
      const nk = remapBoardKeyFoodToRestaurants(k);
      merged[nk] = [...(merged[nk] ?? []), ...list];
    }
    return merged;
  } catch {
    return {};
  }
}

function parseQuotesFromStorage(raw: string | null): Record<string, QuoteEntry[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, QuoteEntry[]> = {};
    for (const [boardKey, rows] of Object.entries(parsed)) {
      if (!boardKey.trim() || !Array.isArray(rows)) continue;
      out[boardKey] = rows
        .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
        .map((row) => ({
          id: typeof row.id === "string" && row.id.trim() ? row.id : crypto.randomUUID(),
          text: typeof row.text === "string" ? row.text : "",
          source: typeof row.source === "string" ? row.source : "",
          addedAtMs: typeof row.addedAtMs === "number" && Number.isFinite(row.addedAtMs) ? row.addedAtMs : undefined,
        }))
        .filter((e) => e.text.trim());
    }
    return out;
  } catch {
    return {};
  }
}

type BoardTextRow = {
  id: string;
  board_key: string;
  kind: "link" | "quote";
  payload: Record<string, unknown>;
  created_at?: string | null;
};

function getActiveFrameShareToken(
  frameCount: number,
  collapsedToken: "--collapsed-width" | "--accordion-mobile-collapsed-height",
) {
  const collapsedPanels = Math.max(0, frameCount - 1);
  if (collapsedPanels === 0) return "100%";

  const sizeChunk = Array.from({ length: collapsedPanels }, () => `var(${collapsedToken})`).join(
    " - ",
  );
  const gapChunk = Array.from({ length: collapsedPanels }, () => "var(--accordion-gap)").join(
    " - ",
  );

  return `calc(100% - ${sizeChunk} - ${gapChunk})`;
}

function getActiveFrameWidthToken(frameCount: number) {
  return getActiveFrameShareToken(frameCount, "--collapsed-width");
}

type LiveClockProps = { theme: ThemeName };

function LiveClock({ theme }: LiveClockProps) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <time className="topTimestamp" dateTime={now?.toISOString()}>
      {now
        ? theme === "minimal"
          ? formatMinimalTimestamp(now)
          : new Intl.DateTimeFormat("en", {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
            }).format(now)
        : ""}
    </time>
  );
}

function ProfileMenuGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden stroke="currentColor" strokeWidth="1.75">
      <circle cx="12" cy="8" r="4" strokeLinecap="round" />
      <path strokeLinecap="round" d="M5 21c1.76-5.25 13.33-5.06 14 0" />
    </svg>
  );
}

/** Up-right arrow out of a box — external / new-tab link on image tiles (not the word “TMDB”). */
function CanvasExternalLinkGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function useWideLayout(minPx = 768) {
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${minPx}px)`);
    function sync() {
      setWide(mq.matches);
    }
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [minPx]);

  return wide;
}

export default function Home() {
  const currentMonthIndex = getCurrentMonthIndex();
  const [activeMonthIndex, setActiveMonthIndex] = useState(currentMonthIndex);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexRef = useRef(0);
  activeIndexRef.current = activeIndex;
  const [openDirection, setOpenDirection] = useState<OpenDirection>("ltr");
  const [imagesByBoard, setImagesByBoard] = useState<Record<string, CanvasImage[]>>({});
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [, setSaveStatus] = useState(supabase ? "SUPABASE CONNECTED" : "LOCAL ONLY");
  const [user, setUser] = useState<User | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authAwaitingCode, setAuthAwaitingCode] = useState(false);
  const [authOtp, setAuthOtp] = useState("");
  const [authRequestBusy, setAuthRequestBusy] = useState(false);
  const otpSendCooldownUntilRef = useRef(0);
  const [editMode, setEditMode] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeName>("brutalist");
  const [categories, setCategories] = useState<Category[]>(DEFAULT_CATEGORIES);
  const [categoriesHydrated, setCategoriesHydrated] = useState(false);
  const [linksByBoard, setLinksByBoard] = useState<Record<string, LinkEntry[]>>({});
  const [quotesByBoard, setQuotesByBoard] = useState<Record<string, QuoteEntry[]>>({});
  const [textBoardsHydrated, setTextBoardsHydrated] = useState(false);
  const [linkDraft, setLinkDraft] = useState({ url: "", title: "", note: "" });
  const [quoteDraft, setQuoteDraft] = useState({ text: "", source: "" });
  const [linkComposerOpen, setLinkComposerOpen] = useState(false);
  const [quoteComposerOpen, setQuoteComposerOpen] = useState(false);
  const [bookCarouselIndexByBoard, setBookCarouselIndexByBoard] = useState<Record<string, number>>(
    {},
  );
  const [tmdbPickerCategoryId, setTmdbPickerCategoryId] = useState<string | null>(null);
  const [tmdbSearchQuery, setTmdbSearchQuery] = useState("");
  const [tmdbSearchResults, setTmdbSearchResults] = useState<TmdbSearchHit[]>([]);
  const [tmdbSearchBusy, setTmdbSearchBusy] = useState(false);
  const [tmdbAddBusyKey, setTmdbAddBusyKey] = useState<string | null>(null);
  const [tmdbMessage, setTmdbMessage] = useState<string | null>(null);
  const [openLibraryPickerCategoryId, setOpenLibraryPickerCategoryId] = useState<string | null>(
    null,
  );
  const [openLibrarySearchQuery, setOpenLibrarySearchQuery] = useState("");
  const [openLibrarySearchResults, setOpenLibrarySearchResults] = useState<OpenLibrarySearchHit[]>(
    [],
  );
  const [openLibrarySearchBusy, setOpenLibrarySearchBusy] = useState(false);
  const [openLibraryAddBusyKey, setOpenLibraryAddBusyKey] = useState<string | null>(null);
  const [openLibraryMessage, setOpenLibraryMessage] = useState<string | null>(null);
  const [nominatimPickerCategoryId, setNominatimPickerCategoryId] = useState<string | null>(null);
  const [nominatimQuery, setNominatimQuery] = useState("");
  const [nominatimResults, setNominatimResults] = useState<NominatimSearchHit[]>([]);
  const [nominatimSearchBusy, setNominatimSearchBusy] = useState(false);
  const [nominatimMessage, setNominatimMessage] = useState<string | null>(null);
  const [nominatimAddBusyKey, setNominatimAddBusyKey] = useState<string | null>(null);
  /** Year overview: click opens dialog; hover uses fixed-layer peek (avoids workspace overflow clip). */
  const [yearMediaPreview, setYearMediaPreview] = useState<CanvasImage | null>(null);
  const [yearMediaPeek, setYearMediaPeek] = useState<YearMediaHoverPeek | null>(null);
  const yearOverviewWorkspaceBodyRef = useRef<HTMLDivElement | null>(null);
  const yearMediaGridRef = useRef<HTMLDivElement | null>(null);
  const [yearMediaLayoutCols, setYearMediaLayoutCols] = useState(YEAR_MEDIA_GRID_COLUMNS);
  const imagesByBoardRef = useRef<Record<string, CanvasImage[]>>({});
  const categoriesRef = useRef<Category[]>(DEFAULT_CATEGORIES);
  const titleStableRef = useRef<Record<string, string>>({});
  const frameArticleRefs = useRef<(HTMLElement | null)[]>([]);
  /** Skip first mobile scroll-into-band so refresh keeps content below fixed chrome (padding-top). */
  const skipMobileFrameScrollIntoViewRef = useRef(true);
  /** `scroll-padding` / `scrollIntoView` are unreliable on iOS; we scroll `main` using measured chrome height. */
  const pageMainElRef = useRef<HTMLElement | null>(null);
  const mobileChromeElRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const bookCarouselDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    boardKey: string;
    startIndex: number;
    total: number;
    moved: boolean;
  } | null>(null);
  const suppressBookCarouselClickUntilRef = useRef(0);
  const lastDragAppliedRef = useRef<{
    imageKey: string;
    imageId: string;
    x: number;
    y: number;
    width: number;
  } | null>(null);
  /** Fixed at mount; aligns overview tab label with calendar year users expect. */
  const calendarOverviewYear = useMemo(() => new Date().getFullYear(), []);
  const isYearOverview = activeMonthIndex === YEAR_OVERVIEW_SLOT_INDEX;
  const activeMonth = !isYearOverview ? (months[activeMonthIndex] ?? null) : null;

  const monthIds = useMemo(() => months.map((m) => m.id), []);

  const yearMergedBoards = useMemo(() => {
    return categories.map((cat) => {
      const variant = cat.variant ?? "canvas";
      if (variant === "links") {
        return {
          cat,
          variant,
          images: [] as CanvasImage[],
          links: mergeLinksForYearCategory(linksByBoard, cat.id, monthIds, calendarOverviewYear),
          quotes: [] as QuoteEntry[],
        };
      }
      if (variant === "quotes") {
        return {
          cat,
          variant,
          images: [] as CanvasImage[],
          links: [] as LinkEntry[],
          quotes: mergeQuotesForYearCategory(quotesByBoard, cat.id, monthIds, calendarOverviewYear),
        };
      }
      return {
        cat,
        variant,
        images: mergeImagesForYearCategory(imagesByBoard, cat.id, monthIds, calendarOverviewYear),
        links: [] as LinkEntry[],
        quotes: [] as QuoteEntry[],
      };
    });
  }, [categories, imagesByBoard, linksByBoard, quotesByBoard, monthIds, calendarOverviewYear]);

  const safeYearBoardIndex = clamp(activeIndex, 0, Math.max(0, yearMergedBoards.length - 1));
  const selectedYearBoard =
    yearMergedBoards.length > 0 ? (yearMergedBoards[safeYearBoardIndex] ?? null) : null;

  const yearMediaGridSlots = useMemo<(CanvasImage | null)[] | null>(() => {
    if (!selectedYearBoard || selectedYearBoard.variant !== "canvas") return null;
    const imgs = selectedYearBoard.images;
    const cols = YEAR_MEDIA_GRID_COLUMNS;
    const rows = Math.max(YEAR_MEDIA_GRID_MIN_ROWS, Math.ceil(imgs.length / cols));
    const total = rows * cols;
    const slots = imgs.slice(0, total) as (CanvasImage | null)[];
    while (slots.length < total) slots.push(null);
    return slots;
  }, [selectedYearBoard]);

  useLayoutEffect(() => {
    if (!yearMediaGridSlots) return;
    const el = yearMediaGridRef.current;
    if (!el) return;
    const update = () => {
      setYearMediaLayoutCols(readYearMediaGridColumnCount(el));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [yearMediaGridSlots]);

  const yearOverviewTotalCount = useMemo(
    () =>
      yearMergedBoards.reduce((sum, row) => {
        if (row.variant === "canvas") return sum + row.images.length;
        if (row.variant === "links") return sum + row.links.length;
        return sum + row.quotes.length;
      }, 0),
    [yearMergedBoards],
  );

  const canEdit = Boolean(user) || ALLOW_LOCAL_EDIT_WITHOUT_AUTH;
  const wideLayout = useWideLayout(768);

  const pastMonthBoardImageCounts = useMemo(
    () =>
      months.map((monthMeta) =>
        categories.reduce((sum, cat) => {
          const key = `${monthMeta.id}-${cat.id}`;
          const variant = cat.variant ?? "canvas";
          if (variant === "canvas") return sum + (imagesByBoard[key]?.length ?? 0);
          if (variant === "links") return sum + (linksByBoard[key]?.length ?? 0);
          return sum + (quotesByBoard[key]?.length ?? 0);
        }, 0),
      ),
    [categories, imagesByBoard, linksByBoard, quotesByBoard],
  );

  const clearCanvasSelection = useCallback(() => {
    setSelectedImageId(null);
  }, []);

  /** Fixed-position card so `.yearOverviewWorkspaceBody` scroll + `overflow` don’t clip the image. */
  const showYearMediaPeekFromCell = useCallback((src: string, cellEl: HTMLElement) => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = cellEl.getBoundingClientRect();
    const pad = 10;
    const estMaxH = Math.min(window.innerHeight * 0.44, 440);
    const gap = 18;
    const spaceAbove = r.top - pad;
    const spaceBelow = window.innerHeight - r.bottom - pad;
    const reserve = estMaxH + gap;
    const placement =
      spaceAbove >= reserve
        ? "above"
        : spaceBelow >= reserve
          ? "below"
          : spaceAbove >= spaceBelow
            ? "above"
            : "below";
    const anchorPx = placement === "above" ? r.top : r.bottom;
    const panelHalfGuess = Math.min(window.innerWidth * 0.26, 190);
    const cx = Math.min(
      Math.max(r.left + r.width / 2, pad + panelHalfGuess),
      window.innerWidth - pad - panelHalfGuess,
    );
    setYearMediaPeek({ src, cx, anchorPx, placement });
  }, []);

  useEffect(() => {
    if (!accountMenuOpen && !themeMenuOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setAccountMenuOpen(false);
      setThemeMenuOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [accountMenuOpen, themeMenuOpen]);

  useEffect(() => {
    if (!isYearOverview) {
      setYearMediaPreview(null);
      setYearMediaPeek(null);
    }
  }, [isYearOverview]);

  useEffect(() => {
    if (yearMediaPreview) setYearMediaPeek(null);
  }, [yearMediaPreview]);

  useEffect(() => {
    if (!yearMediaPeek) return;
    const workspace = yearOverviewWorkspaceBodyRef.current;
    function clearPeek() {
      setYearMediaPeek(null);
    }
    workspace?.addEventListener("scroll", clearPeek, { passive: true });
    window.addEventListener("scroll", clearPeek, { passive: true });
    window.addEventListener("resize", clearPeek);
    return () => {
      workspace?.removeEventListener("scroll", clearPeek);
      window.removeEventListener("scroll", clearPeek);
      window.removeEventListener("resize", clearPeek);
    };
  }, [yearMediaPeek]);

  useEffect(() => {
    if (!yearMediaPreview) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setYearMediaPreview(null);
    }
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [yearMediaPreview]);

  useEffect(() => {
    if (!user) setAccountMenuOpen(false);
  }, [user]);

  useEffect(() => {
    setEditMode(new URLSearchParams(window.location.search).get("edit") === "1");
    let storedTheme = window.localStorage.getItem("monthly-record-theme") as ThemeName | (string & {}) | null;
    if (storedTheme === "gallery") {
      storedTheme = "paper";
      window.localStorage.setItem("monthly-record-theme", "paper");
    }
    if (storedTheme === "bnw") {
      storedTheme = "minimal";
      window.localStorage.setItem("monthly-record-theme", "minimal");
    }
    if (storedTheme === "ink") {
      storedTheme = "brutalist";
      window.localStorage.setItem("monthly-record-theme", "brutalist");
    }
    if (storedTheme && themes.some((themeOption) => themeOption.id === storedTheme)) {
      setTheme(storedTheme as ThemeName);
    }
  }, []);

  function updateTheme(nextTheme: ThemeName) {
    setTheme(nextTheme);
    setThemeMenuOpen(false);
    window.localStorage.setItem("monthly-record-theme", nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
  }

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  function openFrame(index: number, options?: { preserveTmdbPicker?: boolean }) {
    if (index === activeIndexRef.current) {
      return;
    }
    setOpenDirection(index > activeIndexRef.current ? "ltr" : "rtl");
    setActiveIndex(index);
    setSelectedImageId(null);
    if (!options?.preserveTmdbPicker) {
      setTmdbPickerCategoryId(null);
      setOpenLibraryPickerCategoryId(null);
      setNominatimPickerCategoryId(null);
    }
  }

  useEffect(() => {
    if (wideLayout) {
      skipMobileFrameScrollIntoViewRef.current = true;
    }
  }, [wideLayout]);

  useEffect(() => {
    if (wideLayout || isYearOverview) return;
    const el = frameArticleRefs.current[activeIndex];
    if (!el) return;
    if (skipMobileFrameScrollIntoViewRef.current) {
      skipMobileFrameScrollIntoViewRef.current = false;
      return;
    }
    const pageEl = pageMainElRef.current;
    const chromeEl =
      mobileChromeElRef.current ?? document.querySelector<HTMLElement>("header.mobileAppChrome");
    if (!pageEl || !chromeEl) return;

    const gapPx = 14;
    /** Re-run after accordion height / clip-path settles (see `--motion-panel-duration` in CSS). */
    const postAnimationMs = 650;

    let cancelled = false;
    const fenceScroll = (behavior: ScrollBehavior) => {
      const chromeBottom = chromeEl.getBoundingClientRect().bottom;
      const frameTop = el.getBoundingClientRect().top;
      const delta = frameTop - chromeBottom - gapPx;
      if (Math.abs(delta) < 2) return;
      pageEl.scrollTo({
        top: Math.max(0, pageEl.scrollTop + delta),
        behavior,
      });
    };

    const id = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (cancelled) return;
        const chromeBottom = chromeEl.getBoundingClientRect().bottom;
        const frameTop = el.getBoundingClientRect().top;
        const rough = Math.abs(frameTop - chromeBottom - gapPx);
        fenceScroll(rough > 72 ? "auto" : "smooth");
      });
    });

    const tMid = window.setTimeout(() => {
      if (!cancelled) fenceScroll("auto");
    }, 120);

    const tLate = window.setTimeout(() => {
      if (!cancelled) fenceScroll("auto");
    }, postAnimationMs);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(id);
      window.clearTimeout(tMid);
      window.clearTimeout(tLate);
    };
  }, [activeIndex, wideLayout, isYearOverview, activeMonth?.id]);

  useEffect(() => {
    if (!isYearOverview) return;
    function onKey(event: KeyboardEvent) {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => clamp(i - 1, 0, Math.max(0, categories.length - 1)));
      } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => clamp(i + 1, 0, Math.max(0, categories.length - 1)));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isYearOverview, categories.length]);

  useEffect(() => {
    imagesByBoardRef.current = imagesByBoard;
  }, [imagesByBoard]);

  useEffect(() => {
    categoriesRef.current = categories;
  }, [categories]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CATEGORIES_STORAGE_KEY);
      if (!raw) {
        setCategoriesHydrated(true);
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        setCategoriesHydrated(true);
        return;
      }
      const next: Category[] = [];
      for (const row of parsed) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : "";
        if (!id) continue;
        const label = typeof r.label === "string" ? r.label : "";
        const note = typeof r.note === "string" ? r.note : "";
        const color =
          typeof r.color === "string" && r.color ? r.color : DEFAULT_CATEGORIES[0].color;
        const textColor =
          typeof r.textColor === "string" && r.textColor
            ? r.textColor
            : DEFAULT_CATEGORIES[0].textColor;
        const variantRaw = r.variant;
        const variant: BoardVariant =
          variantRaw === "links" || variantRaw === "quotes" || variantRaw === "canvas"
            ? variantRaw
            : "canvas";
        next.push({
          id,
          label: label.trim() || "UNTITLED",
          note,
          color,
          textColor,
          variant,
        });
      }
      if (next.length > 0) {
        const have = new Set(next.map((c) => c.id));
        for (const def of DEFAULT_CATEGORIES) {
          if (!have.has(def.id)) {
            next.push({
              ...def,
              variant: def.variant ?? "canvas",
            });
          }
        }
        setCategories(
          upgradeLegacyLinksFrameCategories(
            upgradeLegacyRestaurantsLabels(upgradeFoodCategoryToRestaurants(next)),
          ),
        );
      }
    } catch {
      /* ignore */
    }
    setCategoriesHydrated(true);
  }, []);

  useEffect(() => {
    if (theme !== "minimal" || !categoriesHydrated) return;
    setCategories((prev) => {
      let changed = false;
      const next = prev.map((c) => {
        const nl = formatMinimalSentenceCase(c.label);
        if (nl !== c.label) changed = true;
        return { ...c, label: nl };
      });
      return changed ? next : prev;
    });
  }, [theme, categoriesHydrated]);

  useEffect(() => {
    if (!categoriesHydrated) return;
    window.localStorage.setItem(CATEGORIES_STORAGE_KEY, JSON.stringify(categories));
  }, [categories, categoriesHydrated]);

  useEffect(() => {
    setActiveIndex((index) =>
      clamp(index, 0, Math.max(0, categories.length - 1)),
    );
  }, [categories.length]);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthMessage("");
      setAuthAwaitingCode(false);
      setAuthOtp("");
      setAuthRequestBusy(false);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    async function loadFavorites() {
      if (!supabase) {
        setSaveStatus("LOCAL ONLY");
        return;
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (ALLOW_LOCAL_EDIT_WITHOUT_AUTH && !session?.user) {
        setSaveStatus("LOCAL ONLY");
        return;
      }

      const { data, error } = await supabase
        .from(FAVORITES_TABLE)
        .select(
          "id, board_key, month_id, category_index, category_label, image_url, storage_path, x, y, width, rotation, created_at",
        )
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Could not load Supabase favorites:", error.message);
        setSaveStatus("LOAD ERROR");
        return;
      }

      const grouped = (data as FavoriteItemRow[]).reduce<Record<string, CanvasImage[]>>(
        (boards, row) => {
          if (!row.image_url) return boards;
          const key = remapBoardKeyFoodToRestaurants(canonicalBoardKey(row.board_key));
          const tmdb = parseTmdbFromStoragePath(row.storage_path);
          const ol = parseOpenLibraryFromStoragePath(row.storage_path);
          boards[key] = [
            ...(boards[key] ?? []),
            {
              id: row.id,
              src: row.image_url,
              storagePath: row.storage_path ?? undefined,
              x: row.x,
              y: row.y,
              width: row.width,
              rotation: row.rotation,
              addedAtMs: row.created_at ? new Date(row.created_at).getTime() : undefined,
              ...(tmdb ?? {}),
              ...(ol ?? {}),
            },
          ];

          return boards;
        },
        {},
      );

      imagesByBoardRef.current = grouped;
      setImagesByBoard(grouped);
      setSaveStatus("SUPABASE CONNECTED");
    }

    void loadFavorites();
  }, [user?.id]);

  useEffect(() => {
    const lsLinks = parseLinksFromStorage(window.localStorage.getItem(LINKS_STORAGE_KEY));
    const lsQuotes = parseQuotesFromStorage(window.localStorage.getItem(QUOTES_STORAGE_KEY));
    setLinksByBoard(lsLinks);
    setQuotesByBoard(lsQuotes);
    setTextBoardsHydrated(true);
  }, []);

  useEffect(() => {
    if (!textBoardsHydrated) return;
    try {
      window.localStorage.setItem(LINKS_STORAGE_KEY, JSON.stringify(linksByBoard));
      window.localStorage.setItem(QUOTES_STORAGE_KEY, JSON.stringify(quotesByBoard));
    } catch {
      /* ignore */
    }
  }, [linksByBoard, quotesByBoard, textBoardsHydrated]);

  useEffect(() => {
    if (!supabase) return;

    void (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (ALLOW_LOCAL_EDIT_WITHOUT_AUTH && !session?.user) return;

      const { data, error } = await supabase
        .from(BOARD_TEXT_TABLE)
        .select("id, board_key, kind, payload, created_at")
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Could not load board text items:", error.message);
        return;
      }

      const remoteLinks: Record<string, LinkEntry[]> = {};
      const remoteQuotes: Record<string, QuoteEntry[]> = {};

      if (data && data.length > 0) {
        for (const row of data as BoardTextRow[]) {
          const key = remapBoardKeyFoodToRestaurants(canonicalBoardKey(row.board_key));
          const p = row.payload;
          if (row.kind === "link") {
            const url = typeof p.url === "string" ? p.url : "";
            if (!url.trim()) continue;
            const thumbRaw = p.thumbUrl;
            const entry: LinkEntry = {
              id: row.id,
              url,
              title: typeof p.title === "string" ? p.title : "",
              note: typeof p.note === "string" ? p.note : "",
              thumbUrl:
                typeof thumbRaw === "string" && thumbRaw.trim() ? thumbRaw.trim() : undefined,
              addedAtMs: row.created_at ? new Date(row.created_at).getTime() : undefined,
            };
            remoteLinks[key] = [...(remoteLinks[key] ?? []), entry];
          } else if (row.kind === "quote") {
            const text = typeof p.text === "string" ? p.text : "";
            if (!text.trim()) continue;
            const entry: QuoteEntry = {
              id: row.id,
              text,
              source: typeof p.source === "string" ? p.source : "",
              addedAtMs: row.created_at ? new Date(row.created_at).getTime() : undefined,
            };
            remoteQuotes[key] = [...(remoteQuotes[key] ?? []), entry];
          }
        }
      }

      setLinksByBoard((prev) => mergeTextBoardsById(prev, remoteLinks));
      setQuotesByBoard((prev) => mergeTextBoardsById(prev, remoteQuotes));
    })();
  }, [user?.id]);

  useEffect(() => {
    setLinkDraft({ url: "", title: "", note: "" });
    setQuoteDraft({ text: "", source: "" });
    setLinkComposerOpen(false);
    setQuoteComposerOpen(false);
    setOpenLibraryPickerCategoryId(null);
    setOpenLibrarySearchQuery("");
    setOpenLibrarySearchResults([]);
    setOpenLibraryMessage(null);
    setOpenLibrarySearchBusy(false);
    setOpenLibraryAddBusyKey(null);
    setNominatimPickerCategoryId(null);
    setNominatimQuery("");
    setNominatimResults([]);
    setNominatimMessage(null);
    setNominatimSearchBusy(false);
    setNominatimAddBusyKey(null);
  }, [activeIndex, activeMonthIndex]);

  /** Debounced TMDB search while the Media picker is open. */
  useEffect(() => {
    if (tmdbPickerCategoryId !== TMDB_MEDIA_CATEGORY_ID) return;

    const trimmed = tmdbSearchQuery.trim();
    if (trimmed.length < 2) {
      setTmdbSearchResults([]);
      setTmdbMessage(null);
      setTmdbSearchBusy(false);
      return;
    }

    const ac = new AbortController();
    const debounceMs = 300;
    const timer = window.setTimeout(() => {
      void (async () => {
        setTmdbSearchBusy(true);
        setTmdbMessage(null);
        try {
          const res = await fetch(`/api/tmdb/search?q=${encodeURIComponent(trimmed)}`, {
            signal: ac.signal,
          });
          const data = (await res.json()) as { error?: string; results?: TmdbSearchHit[] };
          if (ac.signal.aborted) return;
          if (!res.ok) {
            setTmdbSearchResults([]);
            setTmdbMessage(
              typeof data.error === "string"
                ? data.error
                : theme === "minimal"
                  ? "Search failed."
                  : "SEARCH FAILED",
            );
            return;
          }
          const hits = Array.isArray(data.results) ? data.results : [];
          setTmdbSearchResults(hits);
          if (hits.length === 0) {
            setTmdbMessage(
              theme === "minimal"
                ? "No movies or TV shows found."
                : "NO MOVIES OR TV SHOWS FOUND",
            );
          } else {
            setTmdbMessage(null);
          }
        } catch {
          if (ac.signal.aborted) return;
          setTmdbSearchResults([]);
          setTmdbMessage(theme === "minimal" ? "Search failed." : "SEARCH FAILED");
        } finally {
          if (!ac.signal.aborted) setTmdbSearchBusy(false);
        }
      })();
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [tmdbSearchQuery, tmdbPickerCategoryId, theme]);

  /** Debounced Open Library search while the Books picker is open. */
  useEffect(() => {
    if (openLibraryPickerCategoryId !== OPEN_LIBRARY_BOOKS_CATEGORY_ID) return;

    const trimmed = openLibrarySearchQuery.trim();
    if (trimmed.length < 2) {
      setOpenLibrarySearchResults([]);
      setOpenLibraryMessage(null);
      setOpenLibrarySearchBusy(false);
      return;
    }

    const ac = new AbortController();
    const debounceMs = 300;
    const timer = window.setTimeout(() => {
      void (async () => {
        setOpenLibrarySearchBusy(true);
        setOpenLibraryMessage(null);
        try {
          const res = await fetch(`/api/openlibrary/search?q=${encodeURIComponent(trimmed)}`, {
            signal: ac.signal,
          });
          const data = (await res.json()) as {
            error?: string;
            results?: OpenLibrarySearchHit[];
          };
          if (ac.signal.aborted) return;
          if (!res.ok) {
            setOpenLibrarySearchResults([]);
            setOpenLibraryMessage(
              typeof data.error === "string"
                ? data.error
                : theme === "minimal"
                  ? "Search failed."
                  : "SEARCH FAILED",
            );
            return;
          }
          const hits = Array.isArray(data.results) ? data.results : [];
          setOpenLibrarySearchResults(hits);
          if (hits.length === 0) {
            setOpenLibraryMessage(
              theme === "minimal" ? "No books found." : "NO BOOKS FOUND",
            );
          } else {
            setOpenLibraryMessage(null);
          }
        } catch {
          if (ac.signal.aborted) return;
          setOpenLibrarySearchResults([]);
          setOpenLibraryMessage(theme === "minimal" ? "Search failed." : "SEARCH FAILED");
        } finally {
          if (!ac.signal.aborted) setOpenLibrarySearchBusy(false);
        }
      })();
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [openLibrarySearchQuery, openLibraryPickerCategoryId, theme]);

  function boardKey(categoryId: string, monthIndex = activeMonthIndex) {
    return `${months[monthIndex].id}-${categoryId}`;
  }

  function monthIdFromBoardKey(boardKey: string) {
    const dash = boardKey.indexOf("-");
    return dash === -1 ? boardKey : boardKey.slice(0, dash);
  }


  async function patchSupabaseCategoryLabels(categoryId: string, label: string) {
    if (!supabase || !user) return;

    const { error } = await supabase
      .from(FAVORITES_TABLE)
      .update({
        category_label: label,
        updated_at: new Date().toISOString(),
      })
      .like("board_key", `%-${categoryId}`);

    if (error) console.error("Could not update saved labels:", error.message);
  }

  function safeFileName(fileName: string) {
    return fileName.replace(/[^a-z0-9.-]/gi, "-").toLowerCase();
  }

  async function uploadImageFile(file: File, imageKey: string) {
    if (!canEdit) throw new Error("Sign in to add images.");

    let uploadFile: File;
    try {
      uploadFile = await normalizeImageFileForStorage(file);
    } catch {
      throw new Error(
        "Could not decode this photo (often HEIC/HEIF from iPhone — try exporting as JPEG from Photos or use Safari).",
      );
    }

    if (!supabase || !user) {
      return {
        src: URL.createObjectURL(uploadFile),
        storagePath: undefined,
      };
    }

    const storagePath = `${imageKey}/${crypto.randomUUID()}-${safeFileName(uploadFile.name)}`;
    const { error } = await supabase.storage.from(FAVORITES_BUCKET).upload(storagePath, uploadFile);

    if (error) throw error;

    const { data } = supabase.storage.from(FAVORITES_BUCKET).getPublicUrl(storagePath);

    return {
      src: data.publicUrl,
      storagePath,
    };
  }

  async function saveImageRecord(imageKey: string, categoryId: string, image: CanvasImage) {
    if (!canEdit) {
      setSaveStatus("SIGN IN TO EDIT");
      return;
    }

    if (!supabase || !image.storagePath) {
      setSaveStatus("LOCAL ONLY");
      return;
    }

    setSaveStatus("SAVING");
    const monthId = monthIdFromBoardKey(imageKey);
    const cats = categoriesRef.current;
    const categoryIndex = cats.findIndex((c) => c.id === categoryId);
    const categoryLabel =
      cats[categoryIndex >= 0 ? categoryIndex : 0]?.label ??
      cats[0]?.label ??
      "?";

    const { error } = await supabase.from(FAVORITES_TABLE).upsert({
      id: image.id,
      board_key: canonicalBoardKey(imageKey),
      month_id: monthId,
      category_index: categoryIndex >= 0 ? categoryIndex : 0,
      category_label: categoryLabel,
      image_url: image.src,
      storage_path: image.storagePath,
      x: image.x,
      y: image.y,
      width: image.width,
      rotation: image.rotation,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.error("Could not save favorite item:", error.message);
      setSaveStatus("SAVE ERROR");
      return;
    }

    setSaveStatus("SAVED");
  }

  async function appendSingleCanvasImage(
    categoryId: string,
    file: File,
    options?: {
      flushDom?: boolean;
      tmdb?: { id: number; media_type: "movie" | "tv" };
      openLibrary?: { workKey: string; coverId: number };
    },
  ): Promise<boolean> {
    if (!canEdit) {
      setSaveStatus("SIGN IN TO EDIT");
      return false;
    }

    const imageKey = boardKey(categoryId);

    try {
      setSaveStatus(supabase ? "SAVING" : "LOCAL ONLY");
      const existing = imagesByBoardRef.current[imageKey] ?? [];
      const uploaded = await uploadImageFile(file, imageKey);

      const entry: CanvasImage = {
        id: crypto.randomUUID(),
        src: uploaded.src,
        storagePath: uploaded.storagePath,
        x: 12 + (existing.length % 4) * 9,
        y: 28 + (existing.length % 3) * 10,
        width: 30,
        rotation: 0,
        addedAtMs: Date.now(),
        ...(options?.tmdb
          ? { tmdbId: options.tmdb.id, tmdbMediaType: options.tmdb.media_type }
          : {}),
        ...(options?.openLibrary
          ? {
              openLibraryWorkKey: options.openLibrary.workKey,
              openLibraryCoverId: options.openLibrary.coverId,
            }
          : {}),
      };

      const applyImages = (current: Record<string, CanvasImage[]>) => {
        const next = {
          ...current,
          [imageKey]: [...(current[imageKey] ?? []), entry],
        };
        imagesByBoardRef.current = next;
        return next;
      };

      if (options?.flushDom) {
        flushSync(() => {
          setImagesByBoard(applyImages);
        });
      } else {
        setImagesByBoard(applyImages);
      }

      await saveImageRecord(imageKey, categoryId, entry);
      setSaveStatus("SAVED");
      return true;
    } catch (error) {
      console.error(
        "Could not upload image:",
        error instanceof Error ? error.message : String(error),
      );
      setSaveStatus("SAVE ERROR");
      return false;
    }
  }

  async function addImages(event: ChangeEvent<HTMLInputElement>, categoryId: string) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    if (!canEdit) {
      setSaveStatus("SIGN IN TO EDIT");
      event.target.value = "";
      return;
    }

    for (const file of files) {
      await appendSingleCanvasImage(categoryId, file);
    }

    if (categoryId === TMDB_MEDIA_CATEGORY_ID) {
      setTmdbPickerCategoryId(null);
      setTmdbSearchResults([]);
      setTmdbSearchQuery("");
      setTmdbMessage(null);
    }

    if (categoryId === OPEN_LIBRARY_BOOKS_CATEGORY_ID) {
      setOpenLibraryPickerCategoryId(null);
      setOpenLibrarySearchResults([]);
      setOpenLibrarySearchQuery("");
      setOpenLibraryMessage(null);
    }

    event.target.value = "";
  }

  async function addMoviePosterFromTmdb(hit: TmdbSearchHit) {
    if (!hit.poster_path) {
      setTmdbMessage(
        theme === "minimal" ? "No poster for this title." : "NO POSTER FOR THIS TITLE",
      );
      return;
    }

    const busyKey = tmdbHitBusyKey(hit);
    setTmdbAddBusyKey(busyKey);
    setTmdbMessage(null);

    try {
      const params = new URLSearchParams({ size: "w780", poster: hit.poster_path });
      const res = await fetch(`/api/tmdb/image?${params.toString()}`);
      if (!res.ok) {
        setTmdbMessage(theme === "minimal" ? "Could not load poster." : "COULD NOT LOAD POSTER");
        return;
      }

      const blob = await res.blob();
      const ext = blob.type.includes("png")
        ? "png"
        : blob.type.includes("webp")
          ? "webp"
          : "jpg";
      const shortTitle = safeFileName(hit.title).slice(0, 48) || "poster";
      const file = new File([blob], `tmdb-${hit.media_type}-${hit.id}-${shortTitle}.${ext}`, {
        type: blob.type || `image/${ext === "jpg" ? "jpeg" : ext}`,
      });

      const ok = await appendSingleCanvasImage(TMDB_MEDIA_CATEGORY_ID, file, {
        flushDom: true,
        tmdb: { id: hit.id, media_type: hit.media_type },
      });
      if (ok) {
        const mediaIdx = categoriesRef.current.findIndex((c) => c.id === TMDB_MEDIA_CATEGORY_ID);
        if (mediaIdx >= 0 && mediaIdx !== activeIndexRef.current) {
          openFrame(mediaIdx);
        }

        setTmdbPickerCategoryId(null);
        setTmdbSearchResults([]);
        setTmdbSearchQuery("");
        setTmdbMessage(null);
      }
    } catch {
      setTmdbMessage(theme === "minimal" ? "Could not add poster." : "COULD NOT ADD POSTER");
    } finally {
      setTmdbAddBusyKey(null);
    }
  }

  async function addBookCoverFromOpenLibrary(hit: OpenLibrarySearchHit) {
    if (hit.cover_i == null) {
      setOpenLibraryMessage(
        theme === "minimal" ? "No cover for this edition." : "NO COVER FOR THIS EDITION",
      );
      return;
    }

    const busyKey = openLibraryHitBusyKey(hit);
    setOpenLibraryAddBusyKey(busyKey);
    setOpenLibraryMessage(null);

    try {
      const params = new URLSearchParams({
        id: String(hit.cover_i),
        size: "L",
      });
      const res = await fetch(`/api/openlibrary/cover?${params.toString()}`);
      if (!res.ok) {
        setOpenLibraryMessage(
          theme === "minimal" ? "Could not load cover." : "COULD NOT LOAD COVER",
        );
        return;
      }

      const blob = await res.blob();
      const ext = blob.type.includes("png")
        ? "png"
        : blob.type.includes("webp")
          ? "webp"
          : "jpg";
      const shortTitle = safeFileName(hit.title).slice(0, 48) || "cover";
      const file = new File(
        [blob],
        `openlib-work-${hit.work_key}-${shortTitle}.${ext}`,
        {
          type: blob.type || `image/${ext === "jpg" ? "jpeg" : ext}`,
        },
      );

      const ok = await appendSingleCanvasImage(OPEN_LIBRARY_BOOKS_CATEGORY_ID, file, {
        flushDom: true,
        openLibrary: { workKey: hit.work_key, coverId: hit.cover_i },
      });
      if (ok) {
        const booksIdx = categoriesRef.current.findIndex(
          (c) => c.id === OPEN_LIBRARY_BOOKS_CATEGORY_ID,
        );
        if (booksIdx >= 0 && booksIdx !== activeIndexRef.current) {
          openFrame(booksIdx);
        }

        setOpenLibraryPickerCategoryId(null);
        setOpenLibrarySearchResults([]);
        setOpenLibrarySearchQuery("");
        setOpenLibraryMessage(null);
      }
    } catch {
      setOpenLibraryMessage(theme === "minimal" ? "Could not add cover." : "COULD NOT ADD COVER");
    } finally {
      setOpenLibraryAddBusyKey(null);
    }
  }

  async function runNominatimSearch() {
    const trimmed = nominatimQuery.trim();
    if (trimmed.length < 2) {
      setNominatimResults([]);
      setNominatimMessage(
        theme === "minimal" ? "Enter at least 2 characters." : "ENTER AT LEAST 2 CHARACTERS",
      );
      return;
    }

    setNominatimSearchBusy(true);
    setNominatimMessage(null);
    try {
      const res = await fetch(`/api/nominatim/search?q=${encodeURIComponent(trimmed)}`);
      const data = (await res.json()) as { error?: string; results?: NominatimSearchHit[] };
      if (!res.ok) {
        setNominatimResults([]);
        setNominatimMessage(
          typeof data.error === "string"
            ? data.error
            : theme === "minimal"
              ? "Search failed."
              : "SEARCH FAILED",
        );
        return;
      }
      const hits = Array.isArray(data.results) ? data.results : [];
      setNominatimResults(hits);
      setNominatimMessage(
        hits.length === 0
          ? theme === "minimal"
            ? "No places found."
            : "NO PLACES FOUND"
          : null,
      );
    } catch {
      setNominatimResults([]);
      setNominatimMessage(theme === "minimal" ? "Search failed." : "SEARCH FAILED");
    } finally {
      setNominatimSearchBusy(false);
    }
  }

  async function addPlaceFromNominatimHit(hit: NominatimSearchHit) {
    if (!canEdit) {
      setSaveStatus("SIGN IN TO EDIT");
      return;
    }

    const busyKey = nominatimHitBusyKey(hit);
    setNominatimAddBusyKey(busyKey);
    setNominatimMessage(null);

    try {
      const imageKey = boardKey(RESTAURANTS_NOMINATIM_CATEGORY_ID);
      const url = osmBrowseUrl(hit);
      const noteRaw = hit.display_name;
      const note = noteRaw.length > 280 ? `${noteRaw.slice(0, 277).trimEnd()}…` : noteRaw;
      const entry: LinkEntry = {
        id: crypto.randomUUID(),
        url,
        title: placeTitleFromNominatimHit(hit),
        note,
        ...(hit.thumb_url ? { thumbUrl: hit.thumb_url } : {}),
        addedAtMs: Date.now(),
      };

      setLinksByBoard((current) => ({
        ...current,
        [imageKey]: [...(current[imageKey] ?? []), entry],
      }));

      if (!supabase || !user) {
        setSaveStatus("LOCAL ONLY");
      } else {
        setSaveStatus("SAVING");
        await persistLinkToSupabase(imageKey, entry);
      }

      const restIdx = categoriesRef.current.findIndex(
        (c) => c.id === RESTAURANTS_NOMINATIM_CATEGORY_ID,
      );
      if (restIdx >= 0 && restIdx !== activeIndexRef.current) {
        openFrame(restIdx);
      }

      setNominatimPickerCategoryId(null);
      setNominatimResults([]);
      setNominatimQuery("");
      setNominatimMessage(null);
    } catch {
      setNominatimMessage(theme === "minimal" ? "Could not add place." : "COULD NOT ADD PLACE");
    } finally {
      setNominatimAddBusyKey(null);
    }
  }

  function startDrag(event: PointerEvent<HTMLElement>, imageKey: string, imageId: string) {
    event.stopPropagation();
    if (!canEdit) return;

    const canvasEl = event.currentTarget.closest(".imageCanvas");
    if (!(canvasEl instanceof HTMLElement)) return;

    const image = imagesByBoardRef.current[imageKey]?.find((entry) => entry.id === imageId);
    if (!image) return;

    if (event.pointerType === "touch") {
      event.preventDefault();
    }

    const imageRect = event.currentTarget.getBoundingClientRect();
    const pointerId = event.pointerId;
    setSelectedImageId(imageId);
    lastDragAppliedRef.current = null;

    const scrollGuardUnload = installCanvasDragScrollGuard();
    const windowPointerUnload = installCanvasWindowPointerRouting(
      pointerId,
      updateDragGeometry,
      (cx, cy, cancelled) => stopDragAt(cx, cy, cancelled),
    );

    dragRef.current = {
      mode: "move",
      imageKey,
      imageId,
      offsetX: event.clientX - imageRect.left,
      offsetY: event.clientY - imageRect.top,
      element: event.currentTarget,
      pointerId,
      canvasEl,
      scrollGuardUnload,
      windowPointerUnload,
    };
    try {
      event.currentTarget.setPointerCapture(pointerId);
    } catch {
      /* noop */
    }
  }

  function startResize(event: PointerEvent<HTMLSpanElement>, imageKey: string, imageId: string) {
    event.stopPropagation();
    if (!canEdit) return;

    const imageItem = event.currentTarget.closest(".imageItem");
    if (!(imageItem instanceof HTMLElement)) return;

    const canvasEl = imageItem.closest(".imageCanvas");
    if (!(canvasEl instanceof HTMLElement)) return;

    const image = imagesByBoardRef.current[imageKey]?.find((entry) => entry.id === imageId);
    if (!image) return;

    if (event.pointerType === "touch") {
      event.preventDefault();
    }

    const pointerId = event.pointerId;
    setSelectedImageId(imageId);
    lastDragAppliedRef.current = null;

    const scrollGuardUnload = installCanvasDragScrollGuard();
    const windowPointerUnload = installCanvasWindowPointerRouting(
      pointerId,
      updateDragGeometry,
      (cx, cy, cancelled) => stopDragAt(cx, cy, cancelled),
    );

    dragRef.current = {
      mode: "resize",
      imageKey,
      imageId,
      offsetX: 0,
      offsetY: 0,
      element: imageItem,
      pointerId,
      canvasEl,
      scrollGuardUnload,
      windowPointerUnload,
    };
    try {
      event.currentTarget.setPointerCapture(pointerId);
    } catch {
      /* noop */
    }
  }

  function updateDragGeometry(clientX: number, clientY: number) {
    if (!canEdit) return;

    const drag = dragRef.current;
    const canvasEl = drag?.canvasEl;
    if (!drag || !canvasEl || !drag.element) return;

    const image = imagesByBoardRef.current[drag.imageKey]?.find((entry) => entry.id === drag.imageId);
    if (!image) return;

    const canvasRect = canvasEl.getBoundingClientRect();
    if (canvasRect.width < 1 || canvasRect.height < 1) return;

    const { cx, cy } = clampClientPointToCanvas(clientX, clientY, canvasRect);

    const next = getUpdatedImage(image, cx, cy, canvasRect, drag);

    lastDragAppliedRef.current = {
      imageKey: drag.imageKey,
      imageId: drag.imageId,
      x: next.x,
      y: next.y,
      width: drag.mode === "move" ? image.width : next.width,
    };

    if (drag.mode === "move") {
      drag.element.style.left = `${next.x}%`;
      drag.element.style.top = `${next.y}%`;
    } else {
      drag.element.style.width = `${next.width}%`;
    }
  }

  function stopDragAt(clientX: number, clientY: number, cancelled = false) {
    const dragSnap = dragRef.current;
    if (!dragSnap) return;

    dragSnap.scrollGuardUnload?.();
    dragSnap.windowPointerUnload?.();

    if (!dragSnap.element) {
      dragRef.current = null;
      lastDragAppliedRef.current = null;
      return;
    }

    if (!canEdit) {
      if (dragSnap.mode === "move") {
        dragSnap.element.style.removeProperty("left");
        dragSnap.element.style.removeProperty("top");
      } else {
        dragSnap.element.style.removeProperty("width");
      }
      flushSync(() => {
        setImagesByBoard((c) => ({ ...c }));
      });
      dragRef.current = null;
      lastDragAppliedRef.current = null;
      return;
    }

    try {
      dragSnap.element.releasePointerCapture(dragSnap.pointerId);
    } catch {
      /* noop */
    }

    if (cancelled) {
      if (dragSnap.mode === "move") {
        dragSnap.element.style.removeProperty("left");
        dragSnap.element.style.removeProperty("top");
      } else {
        dragSnap.element.style.removeProperty("width");
      }
      flushSync(() => {
        setImagesByBoard((c) => ({ ...c }));
      });
      dragRef.current = null;
      lastDragAppliedRef.current = null;
      return;
    }

    updateDragGeometry(clientX, clientY);

    const priorImage = imagesByBoardRef.current[dragSnap.imageKey]?.find(
      (entry) => entry.id === dragSnap.imageId,
    );

    if (dragSnap.mode === "move") {
      dragSnap.element.style.removeProperty("left");
      dragSnap.element.style.removeProperty("top");
    } else {
      dragSnap.element.style.removeProperty("width");
    }

    const last = lastDragAppliedRef.current;
    lastDragAppliedRef.current = null;
    dragRef.current = null;

    if (
      !last ||
      last.imageId !== dragSnap.imageId ||
      last.imageKey !== dragSnap.imageKey ||
      !priorImage
    ) {
      flushSync(() => {
        setImagesByBoard((c) => ({ ...c }));
      });
      return;
    }

    const categoryId = categoryIdFromBoardKey(dragSnap.imageKey);
    const patchedImage: CanvasImage = {
      ...priorImage,
      x: last.x,
      y: last.y,
      width: dragSnap.mode === "move" ? priorImage.width : last.width,
    };

    const saneGeom =
      Number.isFinite(patchedImage.x) &&
      Number.isFinite(patchedImage.y) &&
      Number.isFinite(patchedImage.width) &&
      patchedImage.width >= 8 &&
      patchedImage.width <= 100 &&
      patchedImage.x >= -0.01 &&
      patchedImage.x <= 100.01 &&
      patchedImage.y >= -0.01 &&
      patchedImage.y <= 100.01;

    if (!saneGeom) {
      flushSync(() => {
        setImagesByBoard((c) => ({ ...c }));
      });
      return;
    }

    setImagesByBoard((current) => {
      const list = current[last.imageKey] ?? [];
      const nextList = list.map((img) =>
        img.id === last.imageId ? patchedImage : img,
      );

      const same =
        nextList.length === list.length &&
        nextList.every(
          (row, idx) =>
            row.x === list[idx]?.x &&
            row.y === list[idx]?.y &&
            row.width === list[idx]?.width,
        );

      if (same) {
        const bumped = {
          ...current,
          [last.imageKey]: [...list],
        };
        imagesByBoardRef.current = bumped;
        return bumped;
      }

      const next = {
        ...current,
        [last.imageKey]: nextList,
      };
      imagesByBoardRef.current = next;

      return next;
    });

    if (categoryId) {
      void saveImageRecord(dragSnap.imageKey, categoryId, patchedImage);
    }
  }

  function getUpdatedImage(
    image: CanvasImage,
    clientX: number,
    clientY: number,
    canvasRect: DOMRect,
    drag: DragState,
  ) {
    if (canvasRect.width < 1 || canvasRect.height < 1) {
      return { ...image };
    }

    if (drag.mode === "resize") {
      const pointerX = ((clientX - canvasRect.left) / canvasRect.width) * 100;
      if (!Number.isFinite(pointerX)) {
        return { ...image };
      }
      const nextWidth = pointerX - image.x;
      const w = clamp(nextWidth, 16, Math.max(16, 100 - image.x));
      if (!Number.isFinite(w)) {
        return { ...image };
      }
      return { ...image, width: w };
    }

    /*
     * MOVE: bounds in canvas %-space — do NOT use getBoundingClientRect() width/height for clamps.
     * Rotated transforms inflate the axis-aligned bounding box vs image.width%/intrinsic layout, yielding
     * negative/tiny maxX and broken drags/huge glitchy commits on desktop + touch.
     */
    const imgEl = drag.element.querySelector("img.canvasImage");
    const displayedWidthPx = (image.width / 100) * canvasRect.width;

    let heightFracOfCanvas: number;
    if (imgEl instanceof HTMLImageElement && imgEl.naturalWidth > 0 && imgEl.naturalHeight > 0) {
      const intrinsicH = (displayedWidthPx * imgEl.naturalHeight) / imgEl.naturalWidth;
      heightFracOfCanvas = (intrinsicH / canvasRect.height) * 100;
    } else {
      heightFracOfCanvas = ((displayedWidthPx * 1.35) / canvasRect.height) * 100;
    }
    heightFracOfCanvas = clamp(heightFracOfCanvas, 1, 100);
    const maxX = Math.max(0, 100 - image.width);
    const maxY = Math.max(0, 100 - heightFracOfCanvas);

    const x = ((clientX - canvasRect.left - drag.offsetX) / canvasRect.width) * 100;
    const y = ((clientY - canvasRect.top - drag.offsetY) / canvasRect.height) * 100;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ...image };
    }

    return {
      ...image,
      width: image.width,
      x: clamp(x, 0, maxX),
      y: clamp(y, 0, maxY),
    };
  }

  function rotateImage(imageKey: string, imageId: string, amount: number) {
    if (!canEdit) return;

    const categoryId = categoryIdFromBoardKey(imageKey);
    const image = imagesByBoardRef.current[imageKey]?.find(
      (currentImage) => currentImage.id === imageId,
    );
    const updatedImage = image ? { ...image, rotation: image.rotation + amount } : null;

    setImagesByBoard((current) => {
      const next = {
        ...current,
        [imageKey]: (current[imageKey] ?? []).map((image) =>
          image.id === imageId ? { ...image, rotation: image.rotation + amount } : image,
        ),
      };
      imagesByBoardRef.current = next;

      return next;
    });

    if (updatedImage && categoryId) {
      void saveImageRecord(imageKey, categoryId, updatedImage);
    }
  }

  async function removeImage(imageKey: string, imageId: string) {
    if (!canEdit) return;

    const image = imagesByBoardRef.current[imageKey]?.find(
      (currentImage) => currentImage.id === imageId,
    );

    if (supabase) {
      setSaveStatus("DELETING");
      const { error } = await supabase.from(FAVORITES_TABLE).delete().eq("id", imageId);
      if (error) {
        console.error("Could not delete favorite from Supabase:", error.message);
        setSaveStatus("DELETE ERROR");
        return;
      }
      if (image?.storagePath) {
        const { error: storageError } = await supabase.storage
          .from(FAVORITES_BUCKET)
          .remove([image.storagePath]);
        if (storageError) console.error("Could not delete stored file:", storageError.message);
      }
      setSaveStatus("SAVED");
    }

    setImagesByBoard((current) => {
      const next = {
        ...current,
        [imageKey]: (current[imageKey] ?? []).filter((currentImage) => currentImage.id !== imageId),
      };
      imagesByBoardRef.current = next;

      return next;
    });

    if (selectedImageId === imageId) setSelectedImageId(null);
  }

  function onBookCarouselPointerDown(
    event: PointerEvent<HTMLDivElement>,
    imageKey: string,
    imageCount: number,
    currentIndex: number,
  ) {
    if (imageCount <= 1) return;
    if (event.button !== 0) return;
    event.stopPropagation();
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest(".bookCarouselControls, .imageControl, button, a")
    ) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    bookCarouselDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      boardKey: imageKey,
      startIndex: currentIndex,
      total: imageCount,
      moved: false,
    };
  }

  function onBookCarouselPointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = bookCarouselDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
      drag.moved = true;
    }
  }

  function finishBookCarouselDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = bookCarouselDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore if already released
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const isSwipe = Math.abs(dx) > 26 && Math.abs(dx) > Math.abs(dy);
    if (isSwipe) {
      const step = dx < 0 ? 1 : -1;
      setBookCarouselIndexByBoard((prev) => ({
        ...prev,
        [drag.boardKey]: wrapIndex(drag.startIndex + step, drag.total),
      }));
      suppressBookCarouselClickUntilRef.current = Date.now() + 180;
    }
    bookCarouselDragRef.current = null;
  }

  async function persistLinkToSupabase(boardKey: string, entry: LinkEntry) {
    if (!supabase || !user || !canEdit) return;
    setSaveStatus("SAVING");
    const { error } = await supabase.from(BOARD_TEXT_TABLE).upsert({
      id: entry.id,
      board_key: canonicalBoardKey(boardKey),
      kind: "link",
      payload: {
        url: entry.url,
        title: entry.title,
        note: entry.note,
        ...(entry.thumbUrl ? { thumbUrl: entry.thumbUrl } : {}),
      },
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.error("Could not save link:", error.message);
      setSaveStatus("SAVE ERROR");
      return;
    }
    setSaveStatus("SAVED");
  }

  async function persistQuoteToSupabase(boardKey: string, entry: QuoteEntry) {
    if (!supabase || !user || !canEdit) return;
    setSaveStatus("SAVING");
    const { error } = await supabase.from(BOARD_TEXT_TABLE).upsert({
      id: entry.id,
      board_key: canonicalBoardKey(boardKey),
      kind: "quote",
      payload: {
        text: entry.text,
        source: entry.source,
      },
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.error("Could not save quote:", error.message);
      setSaveStatus("SAVE ERROR");
      return;
    }
    setSaveStatus("SAVED");
  }

  async function removeBoardTextItemFromRemote(id: string) {
    if (!supabase || !user) return;
    setSaveStatus("DELETING");
    const { error } = await supabase.from(BOARD_TEXT_TABLE).delete().eq("id", id);
    if (error) {
      console.error("Could not delete board text item:", error.message);
      setSaveStatus("DELETE ERROR");
      return;
    }
    setSaveStatus("SAVED");
  }

  function addLinkFromDraft(categoryId: string) {
    if (!canEdit) {
      setSaveStatus("SIGN IN TO EDIT");
      return;
    }

    const url = normalizeUrlInput(linkDraft.url);
    if (!url) return;

    const imageKey = boardKey(categoryId);
    const entry: LinkEntry = {
      id: crypto.randomUUID(),
      url,
      title: linkDraft.title.trim(),
      note: linkDraft.note.trim(),
      addedAtMs: Date.now(),
    };

    setLinksByBoard((current) => ({
      ...current,
      [imageKey]: [...(current[imageKey] ?? []), entry],
    }));
    setLinkDraft({ url: "", title: "", note: "" });
    setLinkComposerOpen(false);

    if (!supabase || !user) {
      setSaveStatus("LOCAL ONLY");
      return;
    }

    void persistLinkToSupabase(imageKey, entry);
  }

  function addQuoteFromDraft(categoryId: string) {
    if (!canEdit) {
      setSaveStatus("SIGN IN TO EDIT");
      return;
    }

    const text = quoteDraft.text.trim();
    if (!text) return;

    const imageKey = boardKey(categoryId);
    const entry: QuoteEntry = {
      id: crypto.randomUUID(),
      text,
      source: quoteDraft.source.trim(),
      addedAtMs: Date.now(),
    };

    setQuotesByBoard((current) => ({
      ...current,
      [imageKey]: [...(current[imageKey] ?? []), entry],
    }));
    setQuoteDraft({ text: "", source: "" });
    setQuoteComposerOpen(false);

    if (!supabase || !user) {
      setSaveStatus("LOCAL ONLY");
      return;
    }

    void persistQuoteToSupabase(imageKey, entry);
  }

  async function removeLinkEntry(imageKey: string, entryId: string) {
    if (!canEdit) return;
    if (supabase && user) await removeBoardTextItemFromRemote(entryId);
    setLinksByBoard((current) => ({
      ...current,
      [imageKey]: (current[imageKey] ?? []).filter((entry) => entry.id !== entryId),
    }));
  }

  async function removeQuoteEntry(imageKey: string, entryId: string) {
    if (!canEdit) return;
    if (supabase && user) await removeBoardTextItemFromRemote(entryId);
    setQuotesByBoard((current) => ({
      ...current,
      [imageKey]: (current[imageKey] ?? []).filter((entry) => entry.id !== entryId),
    }));
  }

  async function sendEmailOtp() {
    if (!supabase || !authEmail.trim() || authRequestBusy) return;

    const now = Date.now();
    if (now < otpSendCooldownUntilRef.current) {
      const sec = Math.ceil((otpSendCooldownUntilRef.current - now) / 1000);
      setAuthMessage(
        theme === "minimal"
          ? `Wait ${sec}s before requesting another sign-in email.`
          : `WAIT ${sec}s BEFORE ANOTHER SIGN-IN EMAIL`,
      );
      return;
    }

    setAuthRequestBusy(true);
    setAuthOtp("");
    setAuthMessage(theme === "minimal" ? "Sending…" : "SENDING···");
    const origin = typeof window !== "undefined" ? window.location.origin : "";

    try {
      // Magic link email can include OTP digits if Magic Link template in Supabase includes {{ .Token }}.
      const { error } = await supabase.auth.signInWithOtp({
        email: authEmail.trim(),
        options: {
          ...(origin ? { emailRedirectTo: `${origin}?edit=1` } : {}),
        },
      });

      if (error) {
        console.error("Could not sign in:", error.message);
        if (isEmailSendRateLimited(error.status, error.message, error.code)) {
          otpSendCooldownUntilRef.current = Date.now() + 65_000;
          setAuthMessage(
            theme === "minimal"
              ? "Too many sign-in emails. Wait about a minute and try again."
              : "TOO MANY EMAILS · WAIT ~1 MIN · TRY AGAIN",
          );
        } else {
          const short =
            error.message.length > 80 ? `${error.message.slice(0, 77)}…` : error.message;
          setAuthMessage(theme === "minimal" ? short : "SIGN IN ERROR");
        }
        setAuthAwaitingCode(false);
        return;
      }

      setAuthAwaitingCode(true);
      setAuthMessage(
        theme === "minimal"
          ? "Check your email and enter the code below."
          : "CHECK EMAIL · ENTER THE CODE BELOW",
      );
    } finally {
      setAuthRequestBusy(false);
    }
  }

  async function verifyEmailOtp() {
    if (!supabase || !authEmail.trim() || !authOtp.trim() || authRequestBusy) return;

    const token = authOtp.replace(/\s/g, "");
    setAuthRequestBusy(true);
    setAuthMessage(theme === "minimal" ? "Verifying…" : "VERIFYING · · ·");

    try {
      const { error } = await supabase.auth.verifyOtp({
        email: authEmail.trim(),
        token,
        type: "email",
      });

      if (error) {
        console.error("Could not verify code:", error.message);
        setAuthMessage("BAD OR EXPIRED CODE");
        return;
      }

      /* Some mobile WebViews deliver SIGNED_IN late; read storage-backed session immediately. */
      const {
        data: { session },
        error: sessionErr,
      } = await supabase.auth.getSession();
      if (sessionErr) {
        console.error("Could not read session after verify:", sessionErr.message);
      }
      setUser(session?.user ?? null);
      if (session?.user) {
        const url = new URL(window.location.href);
        if (url.searchParams.get("edit") !== "1") {
          url.searchParams.set("edit", "1");
          const q = url.searchParams.toString();
          window.history.replaceState({}, "", `${url.pathname}?${q}${url.hash}`);
          setEditMode(true);
        }
        setAuthMessage(theme === "minimal" ? "Signed in." : "SIGNED IN");
      }

      setAuthAwaitingCode(false);
      setAuthOtp("");
    } finally {
      setAuthRequestBusy(false);
    }
  }

  async function submitAuthForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !authEmail.trim()) return;
    if (authRequestBusy) return;
    if (authAwaitingCode) await verifyEmailOtp();
    else await sendEmailOtp();
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setSelectedImageId(null);
    setAuthAwaitingCode(false);
    setAuthOtp("");
    setAuthRequestBusy(false);
    otpSendCooldownUntilRef.current = 0;
    setImagesByBoard({});
    imagesByBoardRef.current = {};
  }

  function leaveEditFlow() {
    const url = new URL(window.location.href);
    url.searchParams.delete("edit");
    const search = url.searchParams.toString();
    window.history.replaceState({}, "", `${url.pathname}${search ? `?${search}` : ""}`);
    setEditMode(false);
  }

  /** Bookmarks often omit `?edit=1`; without it the sign-in UI never mounts (view-only). */
  function enterEditFlow() {
    const url = new URL(window.location.href);
    url.searchParams.set("edit", "1");
    const search = url.searchParams.toString();
    window.history.replaceState({}, "", `${url.pathname}?${search}${url.hash}`);
    setEditMode(true);
  }

  return (
    <main
      ref={pageMainElRef}
      className={[
        "page",
        user && "page--signedIn",
        canEdit && wideLayout && "page--desktopEditChrome",
        isYearOverview ? "page--yearOverview" : "",
        ALLOW_LOCAL_EDIT_WITHOUT_AUTH && !user ? "page--localEditWithoutAuth" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={clearCanvasSelection}
    >
      {user ? (
        <FavoritesAiAgent
          months={months}
          categories={categories}
          imagesByBoard={imagesByBoard}
          linksByBoard={linksByBoard}
          quotesByBoard={quotesByBoard}
          theme={theme}
        />
      ) : null}
      <header className="mobileAppChrome" ref={mobileChromeElRef}>
        <div className="mobileAppChrome__topBand">
          <div className="themePicker" onPointerDown={(event) => event.stopPropagation()}>
            <span className="themePickerPrefix">Theme:</span>
            <div className="themePickerSlot">
              <button
                type="button"
                className="themeSelect"
                id="theme-menu-trigger"
                aria-label="Visual theme"
                aria-haspopup="listbox"
                aria-controls="theme-menu-list"
                aria-expanded={themeMenuOpen}
                onClick={() => setThemeMenuOpen((open) => !open)}
              >
                <span className="themeSelectLabel">
                  {theme === "minimal"
                    ? formatMinimalSentenceCase(
                        themes.find((t) => t.id === theme)?.label ?? "",
                      )
                    : (themes.find((t) => t.id === theme)?.label ?? "")}
                </span>
                <span className="themeSelectCaret" aria-hidden>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M4 6l4 4 4-4"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </button>
              {themeMenuOpen ? (
                <>
                  <button
                    type="button"
                    className="themeMenuBackdrop"
                    aria-label="Close theme menu"
                    tabIndex={-1}
                    onClick={() => setThemeMenuOpen(false)}
                  />
                  <div
                    id="theme-menu-list"
                    className="themeMenu"
                    role="listbox"
                    aria-label="Visual theme"
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    {themes.map((themeOption) => {
                      const label =
                        theme === "minimal"
                          ? formatMinimalSentenceCase(themeOption.label)
                          : themeOption.label;
                      const selected = theme === themeOption.id;
                      return (
                        <button
                          key={themeOption.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className="themeMenuOption"
                          onClick={() => updateTheme(themeOption.id)}
                        >
                          <span className="themeMenuOptionMark" aria-hidden>
                            {selected ? "✓" : ""}
                          </span>
                          <span className="themeMenuOptionLabel">{label}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : null}
            </div>
          </div>
          {ALLOW_LOCAL_EDIT_WITHOUT_AUTH && !user ? (
            <span className="localEditHint" role="status">
              {theme === "minimal" ? "Local · not synced" : "LOCAL · NOT SYNCED"}
            </span>
          ) : null}
          {supabase && !user && !editMode ? (
            <button
              type="button"
              className="authEnterEditButton"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => enterEditFlow()}
            >
              {theme === "minimal" ? "Sign in" : "SIGN IN"}
            </button>
          ) : null}
          <LiveClock theme={theme} />
          {user ? (
            <div className="authSignedIn" onPointerDown={(event) => event.stopPropagation()}>
              <div className="authSignedInDesktop">
                <span className="authUser">{user.email}</span>
                <button className="authButton" type="button" onClick={() => void signOut()}>
                  SIGN OUT
                </button>
              </div>
              <div className="authProfileMobile">
                <button
                  type="button"
                  className="authProfileTrigger"
                  aria-label="Account menu"
                  aria-expanded={accountMenuOpen}
                  aria-haspopup="dialog"
                  onClick={() => setAccountMenuOpen((open) => !open)}
                >
                  <ProfileMenuGlyph />
                </button>
                {accountMenuOpen ? (
                  <>
                    <button
                      type="button"
                      className="authProfileBackdrop"
                      aria-label="Close account menu"
                      onClick={() => setAccountMenuOpen(false)}
                    />
                    <div
                      className="authProfileMenu"
                      role="dialog"
                      aria-label="Account"
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <p className="authProfileEmail">{user.email}</p>
                      <button
                        type="button"
                        className="authProfileSignOutButton"
                        onClick={() => {
                          setAccountMenuOpen(false);
                          void signOut();
                        }}
                      >
                        {theme === "minimal" ? "Sign out" : "SIGN OUT"}
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        <nav className="monthRail" aria-label="Monthly favorite boards">
          {months.map((month, index) => {
            const isFutureMonth = index > currentMonthIndex;
            const isPastMonth = index < currentMonthIndex;
            const pastCount = isPastMonth ? pastMonthBoardImageCounts[index] : null;
            const showEmptyPastBadge = pastCount !== null && pastCount === 0;
            const navLabel = theme === "minimal" ? formatMonthNavLabel(month.id) : month.label;
            const unavailableLabel =
              theme === "minimal"
                ? `${navLabel}, upcoming month • not yet available`
                : `${navLabel}, UPCOMING · NOT AVAILABLE YET`;

            let ariaLabel = navLabel;
            if (showEmptyPastBadge) ariaLabel = `${navLabel}, empty`;
            else if (isFutureMonth) ariaLabel = unavailableLabel;

            return (
              <button
                key={month.id}
                className="monthButton"
                data-active={index === activeMonthIndex ? "true" : undefined}
                data-current={index === currentMonthIndex ? "true" : undefined}
                type="button"
                disabled={isFutureMonth}
                aria-label={ariaLabel}
                onClick={() => {
                  setActiveMonthIndex(index);
                  setSelectedImageId(null);
                }}
              >
                <span aria-hidden="true">{navLabel}</span>
                {showEmptyPastBadge ? (
                  <span className="monthCountBadge" aria-hidden="true">
                    {theme === "minimal" ? "0" : "[0]"}
                  </span>
                ) : null}
              </button>
            );
          })}
          <button
            key="__year-overview__"
            className="monthButton monthButton--year"
            type="button"
            data-active={activeMonthIndex === YEAR_OVERVIEW_SLOT_INDEX ? "true" : undefined}
            aria-label={`${calendarOverviewYear} year overview`}
            onClick={() => {
              setActiveMonthIndex(YEAR_OVERVIEW_SLOT_INDEX);
              setSelectedImageId(null);
            }}
          >
            <span aria-hidden="true">{calendarOverviewYear}</span>
            {yearOverviewTotalCount === 0 ? (
              <span className="monthCountBadge" aria-hidden="true">
                {theme === "minimal" ? "0" : "[0]"}
              </span>
            ) : null}
          </button>
        </nav>
      </header>
      {editMode || user ? (
        !user ? (
          <form
            className="authBar"
            data-auth-state="signed-out"
            data-awaiting-otp={authAwaitingCode ? "true" : undefined}
            onSubmit={(event) => void submitAuthForm(event)}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <h2
              className={`authScreenHeadline${theme === "minimal" ? " authScreenHeadline--minimal" : ""}`}
              id="auth-screen-title"
            >
              {theme === "minimal" ? "Sign in to edit" : "SIGN IN TO EDIT"}
            </h2>
            <input
              className="authInput"
              type="email"
              placeholder="email to edit"
              value={authEmail}
              onChange={(event) => {
                const next = event.target.value;
                setAuthEmail(next);
                setAuthAwaitingCode(false);
                setAuthOtp("");
                setAuthMessage("");
                otpSendCooldownUntilRef.current = 0;
              }}
              autoComplete="email"
              inputMode="email"
            />
            {authAwaitingCode ? (
              <>
                <input
                  className="authInput authInput--otp"
                  type="text"
                  placeholder={theme === "minimal" ? "Code from email" : "ENTER CODE"}
                  value={authOtp}
                  onChange={(event) => setAuthOtp(event.target.value)}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={12}
                  aria-label={
                    theme === "minimal"
                      ? "Verification code from your email"
                      : "Verification code from email"
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void verifyEmailOtp();
                    }
                  }}
                />
                <button
                  className="authButton"
                  type="submit"
                  disabled={authRequestBusy || !authOtp.trim()}
                >
                  {theme === "minimal" ? "Continue" : "CONTINUE"}
                </button>
              </>
            ) : (
              <button className="authButton" type="submit" disabled={authRequestBusy || !authEmail.trim()}>
                SIGN IN
              </button>
            )}
            {authMessage ? <span className="authMessage">{authMessage}</span> : null}
            {editMode ? (
              <button className="authScreenDismiss" type="button" onClick={leaveEditFlow}>
                {theme === "minimal" ? "View without signing in" : "VIEW WITHOUT SIGNING IN"}
              </button>
            ) : null}
          </form>
        ) : null
      ) : null}

      {isYearOverview ? (
        <section
          className="yearOverview"
          aria-label={`${calendarOverviewYear} favorites by category`}
        >
          <div className="yearOverviewWorkspace">
            <nav className="yearCategoryTabs" role="tablist" aria-label="Categories">
              <div className="yearCategoryTabsScroll">
                {yearMergedBoards.map((row, index) => {
                  const count =
                    row.variant === "canvas"
                      ? row.images.length
                      : row.variant === "links"
                        ? row.links.length
                        : row.quotes.length;
                  const isSelected = index === activeIndex;
                  return (
                    <button
                      key={row.cat.id}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      className="yearCategoryTab"
                      data-active={isSelected ? "true" : undefined}
                      onClick={() => {
                        setActiveIndex(index);
                        setSelectedImageId(null);
                        setYearMediaPreview(null);
                        setYearMediaPeek(null);
                      }}
                    >
                      <span className="yearCategoryTabLabel">
                        {theme === "minimal"
                          ? formatMinimalSentenceCase(row.cat.label)
                          : row.cat.label}
                      </span>
                      <span className="yearCategoryTabCount">{count}</span>
                    </button>
                  );
                })}
              </div>
            </nav>
            <header
              className={[
                "yearOverviewWorkspaceHeader",
                selectedYearBoard?.variant === "canvas" ? "yearOverviewWorkspaceHeader--dense" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <p className="yearOverviewWorkspaceMeta">
                {theme === "minimal"
                  ? `${calendarOverviewYear} · All months`
                  : `${calendarOverviewYear} · ALL MONTHS`}
              </p>
              {selectedYearBoard ? (
                <>
                  <h2 className="yearOverviewWorkspaceTitle">
                    {theme === "minimal"
                      ? formatMinimalSentenceCase(selectedYearBoard.cat.label)
                      : selectedYearBoard.cat.label}
                  </h2>
                  <p className="yearOverviewWorkspaceNote">{selectedYearBoard.cat.note}</p>
                </>
              ) : null}
            </header>
            <div
              ref={yearOverviewWorkspaceBodyRef}
              className="yearOverviewWorkspaceBody yearOverviewWorkspaceBody--mediaFlush"
            >
              {!selectedYearBoard ? (
                <p className="yearOverviewEmpty">{theme === "minimal" ? "No categories." : "NO CATEGORIES"}</p>
              ) : selectedYearBoard.variant === "canvas" ? (
                yearMediaGridSlots ? (
                  <div
                    ref={yearMediaGridRef}
                    className="yearMediaGrid"
                    style={
                      {
                        "--year-media-cols": YEAR_MEDIA_GRID_COLUMNS,
                      } as CSSProperties
                    }
                  >
                    {yearMediaGridSlots.map((image, slotIndex) => {
                      const slotCount = yearMediaGridSlots.length;
                      const cols = Math.min(
                        Math.max(1, yearMediaLayoutCols),
                        Math.max(1, slotCount),
                      );
                      /** Width of incomplete last row (always `cols` when `slotCount % cols === 0`). */
                      const slotsInLastRow =
                        slotCount > 0 ? ((slotCount - 1) % cols) + 1 : cols;
                      const lastRowFirst = slotCount - slotsInLastRow;
                      const isEdgeRight = slotIndex % cols === cols - 1;
                      const isEdgeBottom =
                        slotCount > 0 && slotIndex >= lastRowFirst && slotIndex < slotCount;
                      return (
                        <div
                          key={image?.id ?? `year-slot-${selectedYearBoard.cat.id}-${slotIndex}`}
                          className={[
                            "yearMediaGridCell",
                            isEdgeRight ? "yearMediaGridCell--edgeRight" : "",
                            isEdgeBottom ? "yearMediaGridCell--edgeBottom" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          onPointerEnter={(event) => {
                            if (!image) return;
                            showYearMediaPeekFromCell(
                              image.src,
                              event.currentTarget as HTMLElement,
                            );
                          }}
                          onPointerLeave={() => setYearMediaPeek(null)}
                        >
                          {image ? (
                            <button
                              type="button"
                              className="yearMediaGridCellButton"
                              aria-label={
                                theme === "minimal"
                                  ? "View image larger"
                                  : "VIEW IMAGE LARGER"
                              }
                              onClick={() => {
                                setYearMediaPeek(null);
                                setYearMediaPreview(image);
                              }}
                              onFocus={(event) => {
                                const cell = (event.currentTarget as HTMLElement).closest(
                                  ".yearMediaGridCell",
                                );
                                if (cell instanceof HTMLElement)
                                  showYearMediaPeekFromCell(image.src, cell);
                              }}
                              onBlur={() => setYearMediaPeek(null)}
                            >
                              <img
                                className="yearMediaGridCellImg"
                                src={image.src}
                                alt=""
                                loading="lazy"
                                draggable={false}
                              />
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null
              ) : selectedYearBoard.variant === "links" ? (
                selectedYearBoard.links.length > 0 ? (
                  <div className="yearEntryGrid yearEntryGrid--links">
                    {selectedYearBoard.links.map((entry) => (
                      <div key={entry.id} className="yearGridLinkCard">
                        <a
                          className="yearGridLinkAnchor"
                          href={entry.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {entry.thumbUrl ? (
                            <img
                              className="yearGridLinkThumb"
                              src={entry.thumbUrl}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                          ) : null}
                          <span className="linkCardHost">{linkHostname(entry.url)}</span>
                          <span className="linkCardTitle">
                            {linkDisplayHeading(entry.url, entry.title)}
                          </span>
                          <span className="linkCardUrl" title={entry.url}>
                            {entry.url}
                          </span>
                        </a>
                        {entry.note.trim() ? <p className="linkCardNote">{entry.note}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="yearOverviewEmpty">
                    {theme === "minimal"
                      ? `No links from ${calendarOverviewYear}.`
                      : `NO LINKS FROM ${calendarOverviewYear}.`}
                  </p>
                )
              ) : selectedYearBoard.quotes.length > 0 ? (
                <div className="yearEntryGrid yearEntryGrid--quotes">
                  {selectedYearBoard.quotes.map((entry) => (
                    <blockquote key={entry.id} className="yearGridQuoteCard">
                      <p className="yearGridQuoteBody">{entry.text}</p>
                      {entry.source.trim() ? (
                        <cite className="yearGridQuoteSource">{entry.source}</cite>
                      ) : null}
                    </blockquote>
                  ))}
                </div>
              ) : (
                <p className="yearOverviewEmpty">
                  {theme === "minimal"
                    ? `No quotes from ${calendarOverviewYear}.`
                    : `NO QUOTES FROM ${calendarOverviewYear}.`}
                </p>
              )}
            </div>
          </div>
          {yearMediaPeek ? (
            <div
              className={`yearMediaPeekFloating yearMediaPeekFloating--${yearMediaPeek.placement}`}
              style={
                {
                  "--peek-cx": `${yearMediaPeek.cx}px`,
                  "--peek-anchor": `${yearMediaPeek.anchorPx}px`,
                } as CSSProperties
              }
              aria-hidden
            >
              <img
                className="yearMediaPeekFloatingImg"
                src={yearMediaPeek.src}
                alt=""
                draggable={false}
              />
            </div>
          ) : null}
          {yearMediaPreview ? (
            <>
              <button
                type="button"
                className="yearMediaLightboxBackdrop"
                aria-label={theme === "minimal" ? "Close image preview" : "CLOSE IMAGE PREVIEW"}
                onClick={() => setYearMediaPreview(null)}
              />
              <div
                className="yearMediaLightbox"
                role="dialog"
                aria-modal="true"
                aria-label={
                  theme === "minimal"
                    ? `${calendarOverviewYear} image`
                    : `${calendarOverviewYear} IMAGE`
                }
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="yearMediaLightboxClose"
                  aria-label={theme === "minimal" ? "Close" : "CLOSE"}
                  onClick={() => setYearMediaPreview(null)}
                >
                  {theme === "minimal" ? "Close" : "CLOSE"}
                </button>
                <img
                  className="yearMediaLightboxImg"
                  src={yearMediaPreview.src}
                  alt=""
                  draggable={false}
                />
                {(() => {
                  const catalog = catalogExternalPageForImage(yearMediaPreview, theme);
                  if (!catalog) return null;
                  return (
                    <a
                      className="yearMediaLightboxTmdb"
                      href={catalog.href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {catalog.lightboxLabel}
                    </a>
                  );
                })()}
              </div>
            </>
          ) : null}
        </section>
      ) : activeMonth ? (
      <section
        key={activeMonth.id}
        className="accordion"
        aria-label={`${
          theme === "minimal" ? formatMonthNavLabel(activeMonth.id) : activeMonth.label
        } favorite category cards`}
        style={
          {
            "--active-frame-width": getActiveFrameWidthToken(categories.length),
          } as CSSProperties
        }
      >
        {categories.map((item, index) => {
          const isActive = index === activeIndex;
          const imageKey = boardKey(item.id);
          const variant = item.variant ?? "canvas";
          const boardImages = imagesByBoard[imageKey] ?? [];
          const boardLinks = linksByBoard[imageKey] ?? [];
          const boardQuotesList = quotesByBoard[imageKey] ?? [];
          const isBooksCarousel =
            variant === "canvas" && item.id === OPEN_LIBRARY_BOOKS_CATEGORY_ID;
          const bookCarouselIndex = wrapIndex(
            bookCarouselIndexByBoard[imageKey] ?? 0,
            boardImages.length,
          );
          const boardItemCount =
            variant === "canvas"
              ? boardImages.length
              : variant === "links"
                ? boardLinks.length
                : boardQuotesList.length;

          return (
            <article
              ref={(node) => {
                frameArticleRefs.current[index] = node;
              }}
              key={item.id}
              className="frame"
              data-active={isActive ? "true" : undefined}
              data-direction={isActive ? openDirection : undefined}
              style={
                {
                  "--frame-color": item.color,
                  "--frame-text-color": item.textColor,
                } as CSSProperties
              }
              role="button"
              tabIndex={0}
              aria-selected={isActive}
              onClick={() => openFrame(index)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                const el = event.target;
                if (
                  el instanceof HTMLInputElement ||
                  el instanceof HTMLTextAreaElement ||
                  el instanceof HTMLSelectElement
                ) {
                  return;
                }
                if (el instanceof HTMLElement && el.isContentEditable) return;
                event.preventDefault();
                openFrame(index);
              }}
            >
              <span className="frameLabel">
                {`${
                  theme === "minimal" ? formatMinimalSentenceCase(item.label) : item.label
                }[${boardItemCount}]`}
              </span>
              <span className="frameRect">
                <span className="frameContent" aria-hidden={!isActive}>
                  <span className="canvasHeader" onPointerDown={(event) => canEdit && isActive && event.stopPropagation()}>
                    <span
                      className="frameHeadingBlock"
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      {canEdit && isActive ? (
                        <>
                          <label className="srOnly" htmlFor={`frame-title-${item.id}`}>
                            Frame title
                          </label>
                          <input
                            id={`frame-title-${item.id}`}
                            className="frameTitle frameTitleEditable"
                            autoComplete="off"
                            aria-label="Frame title"
                            value={item.label}
                            onFocus={() => {
                              titleStableRef.current[item.id] = item.label;
                            }}
                            onChange={(event) =>
                              setCategories((prev) =>
                                prev.map((c) =>
                                  c.id === item.id ? { ...c, label: event.target.value } : c,
                                ),
                              )
                            }
                            onBlur={(event) => {
                              let trimmed = event.target.value.trim();
                              if (!trimmed) {
                                const revert = titleStableRef.current[item.id] ?? "?";
                                setCategories((prev) =>
                                  prev.map((c) => (c.id === item.id ? { ...c, label: revert } : c)),
                                );
                                return;
                              }
                              const nextLabel = normalizeFrameTitleOnBlur(trimmed, theme, item.id);
                              const prevRaw = (
                                titleStableRef.current[item.id] ?? ""
                              ).trim();
                              const prevCompared = normalizeFrameTitleOnBlur(prevRaw, theme, item.id);
                              if (prevCompared !== nextLabel) {
                                void patchSupabaseCategoryLabels(item.id, nextLabel);
                              }
                              setCategories((prev) =>
                                prev.map((c) =>
                                  c.id === item.id ? { ...c, label: nextLabel } : c,
                                ),
                              );
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                event.currentTarget.blur();
                              }
                            }}
                          />
                          <label className="srOnly" htmlFor={`frame-note-${item.id}`}>
                            Frame subtitle
                          </label>
                          <textarea
                            id={`frame-note-${item.id}`}
                            className="frameNoteEditable"
                            rows={2}
                            aria-label="Frame subtitle"
                            value={item.note}
                            onChange={(event) =>
                              setCategories((prev) =>
                                prev.map((c) =>
                                  c.id === item.id ? { ...c, note: event.target.value } : c,
                                ),
                              )
                            }
                          />
                        </>
                      ) : (
                        <>
                          <span className="frameTitle">
                            {theme === "minimal"
                              ? formatMinimalSentenceCase(item.label)
                              : item.label}
                          </span>
                          <span className="frameNote">{item.note}</span>
                        </>
                      )}
                    </span>
                    {canEdit && variant === "canvas" ? (
                      <span className="canvasActions">
                        {item.id === TMDB_MEDIA_CATEGORY_ID && isActive ? (
                            <button
                              type="button"
                              className="addButton"
                              aria-expanded={
                                tmdbPickerCategoryId === TMDB_MEDIA_CATEGORY_ID ? true : false
                              }
                              aria-label={
                                theme === "minimal"
                                  ? tmdbPickerCategoryId === TMDB_MEDIA_CATEGORY_ID
                                    ? "Close TMDB search"
                                    : "Search TMDB for Media"
                                  : tmdbPickerCategoryId === TMDB_MEDIA_CATEGORY_ID
                                    ? "CLOSE TMDB SEARCH"
                                    : "SEARCH TMDB FOR MEDIA"
                              }
                              tabIndex={isActive ? 0 : -1}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation();
                                const show =
                                  tmdbPickerCategoryId !== TMDB_MEDIA_CATEGORY_ID;
                                setTmdbPickerCategoryId(
                                  show ? TMDB_MEDIA_CATEGORY_ID : null,
                                );
                                if (show) {
                                  setOpenLibraryPickerCategoryId(null);
                                  setOpenLibrarySearchResults([]);
                                  setOpenLibrarySearchQuery("");
                                  setOpenLibraryMessage(null);
                                  setNominatimPickerCategoryId(null);
                                  setNominatimQuery("");
                                  setNominatimResults([]);
                                  setNominatimMessage(null);
                                  setLinkComposerOpen(false);
                                  setQuoteComposerOpen(false);
                                }
                              }}
                            >
                              <span aria-hidden="true">
                                {tmdbPickerCategoryId === TMDB_MEDIA_CATEGORY_ID
                                  ? "×"
                                  : "+"}
                              </span>
                              <span className="srOnly">
                                {theme === "minimal"
                                  ? tmdbPickerCategoryId === TMDB_MEDIA_CATEGORY_ID
                                    ? "Close"
                                    : `Add to ${formatMinimalSentenceCase(item.label)}`
                                  : tmdbPickerCategoryId === TMDB_MEDIA_CATEGORY_ID
                                    ? "CLOSE"
                                    : `ADD TO ${item.label}`}
                              </span>
                            </button>
                        ) : item.id === OPEN_LIBRARY_BOOKS_CATEGORY_ID && isActive ? (
                          <button
                            type="button"
                            className="addButton"
                            aria-expanded={
                              openLibraryPickerCategoryId === OPEN_LIBRARY_BOOKS_CATEGORY_ID
                                ? true
                                : false
                            }
                            aria-label={
                              theme === "minimal"
                                ? openLibraryPickerCategoryId === OPEN_LIBRARY_BOOKS_CATEGORY_ID
                                  ? "Close Open Library search"
                                  : "Search Open Library for Books"
                                : openLibraryPickerCategoryId === OPEN_LIBRARY_BOOKS_CATEGORY_ID
                                  ? "CLOSE OPEN LIBRARY SEARCH"
                                  : "SEARCH OPEN LIBRARY FOR BOOKS"
                            }
                            tabIndex={isActive ? 0 : -1}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              const show =
                                openLibraryPickerCategoryId !== OPEN_LIBRARY_BOOKS_CATEGORY_ID;
                              setOpenLibraryPickerCategoryId(
                                show ? OPEN_LIBRARY_BOOKS_CATEGORY_ID : null,
                              );
                              if (show) {
                                setTmdbPickerCategoryId(null);
                                setTmdbSearchResults([]);
                                setTmdbSearchQuery("");
                                setTmdbMessage(null);
                                setNominatimPickerCategoryId(null);
                                setNominatimQuery("");
                                setNominatimResults([]);
                                setNominatimMessage(null);
                                setLinkComposerOpen(false);
                                setQuoteComposerOpen(false);
                              }
                            }}
                          >
                            <span aria-hidden="true">
                              {openLibraryPickerCategoryId === OPEN_LIBRARY_BOOKS_CATEGORY_ID
                                ? "×"
                                : "+"}
                            </span>
                            <span className="srOnly">
                              {theme === "minimal"
                                ? openLibraryPickerCategoryId === OPEN_LIBRARY_BOOKS_CATEGORY_ID
                                  ? "Close"
                                  : `Add to ${formatMinimalSentenceCase(item.label)}`
                                : openLibraryPickerCategoryId === OPEN_LIBRARY_BOOKS_CATEGORY_ID
                                  ? "CLOSE"
                                  : `ADD TO ${item.label}`}
                            </span>
                          </button>
                        ) : (
                          <label
                            className="addButton"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <span aria-hidden="true">+</span>
                            <span className="srOnly">
                              Add images to{" "}
                              {theme === "minimal"
                                ? formatMinimalSentenceCase(item.label)
                                : item.label}
                            </span>
                            <input
                              className="fileInput"
                              type="file"
                              accept="image/*"
                              multiple
                              tabIndex={isActive ? 0 : -1}
                              onChange={(event) => addImages(event, item.id)}
                            />
                          </label>
                        )}
                      </span>
                    ) : canEdit && variant === "links" && isActive ? (
                      <span className="canvasActions">
                        {item.id === RESTAURANTS_NOMINATIM_CATEGORY_ID ? (
                          nominatimPickerCategoryId === RESTAURANTS_NOMINATIM_CATEGORY_ID ? (
                            <button
                              className="deleteSelectedButton"
                              type="button"
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation();
                                setNominatimPickerCategoryId(null);
                                setNominatimQuery("");
                                setNominatimResults([]);
                                setNominatimMessage(null);
                              }}
                            >
                              {theme === "minimal" ? "Cancel" : "CANCEL"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="addButton"
                              aria-expanded={
                                nominatimPickerCategoryId === RESTAURANTS_NOMINATIM_CATEGORY_ID
                                  ? true
                                  : false
                              }
                              aria-label={
                                theme === "minimal"
                                  ? "Search OpenStreetMap for a place"
                                  : "SEARCH OPENSTREETMAP FOR A PLACE"
                              }
                              tabIndex={isActive ? 0 : -1}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation();
                                const show =
                                  nominatimPickerCategoryId !== RESTAURANTS_NOMINATIM_CATEGORY_ID;
                                setNominatimPickerCategoryId(
                                  show ? RESTAURANTS_NOMINATIM_CATEGORY_ID : null,
                                );
                                if (show) {
                                  setTmdbPickerCategoryId(null);
                                  setTmdbSearchResults([]);
                                  setTmdbSearchQuery("");
                                  setTmdbMessage(null);
                                  setOpenLibraryPickerCategoryId(null);
                                  setOpenLibrarySearchResults([]);
                                  setOpenLibrarySearchQuery("");
                                  setOpenLibraryMessage(null);
                                  setLinkComposerOpen(false);
                                  setLinkDraft({ url: "", title: "", note: "" });
                                  setQuoteComposerOpen(false);
                                }
                              }}
                            >
                              <span aria-hidden="true">+</span>
                              <span className="srOnly">
                                {theme === "minimal"
                                  ? `Add to ${formatMinimalSentenceCase(item.label)}`
                                  : `ADD TO ${item.label}`}
                              </span>
                            </button>
                          )
                        ) : linkComposerOpen ? (
                          <button
                            className="deleteSelectedButton"
                            type="button"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              setLinkComposerOpen(false);
                              setLinkDraft({ url: "", title: "", note: "" });
                            }}
                          >
                            {theme === "minimal" ? "Cancel" : "CANCEL"}
                          </button>
                        ) : (
                          <button
                            className="addButton"
                            type="button"
                            aria-label={
                              theme === "minimal"
                                ? `Add link to ${formatMinimalSentenceCase(item.label)}`
                                : `Add link to ${item.label}`
                            }
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              setNominatimPickerCategoryId(null);
                              setNominatimQuery("");
                              setNominatimResults([]);
                              setNominatimMessage(null);
                              setLinkComposerOpen(true);
                            }}
                          >
                            <span aria-hidden="true">+</span>
                          </button>
                        )}
                      </span>
                    ) : canEdit && variant === "quotes" && isActive ? (
                      <span className="canvasActions">
                        {quoteComposerOpen ? (
                          <button
                            className="deleteSelectedButton"
                            type="button"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              setQuoteComposerOpen(false);
                              setQuoteDraft({ text: "", source: "" });
                            }}
                          >
                            {theme === "minimal" ? "Cancel" : "CANCEL"}
                          </button>
                        ) : (
                          <button
                            className="addButton"
                            type="button"
                            aria-label={
                              theme === "minimal"
                                ? `Add quote to ${formatMinimalSentenceCase(item.label)}`
                                : `Add quote to ${item.label}`
                            }
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              setNominatimPickerCategoryId(null);
                              setNominatimQuery("");
                              setNominatimResults([]);
                              setNominatimMessage(null);
                              setQuoteComposerOpen(true);
                            }}
                          >
                            <span aria-hidden="true">+</span>
                          </button>
                        )}
                      </span>
                    ) : null}
                  </span>
                  {variant === "canvas" ? (
                    <div className="canvasStack">
                      {canEdit &&
                      isActive &&
                      item.id === TMDB_MEDIA_CATEGORY_ID &&
                      tmdbPickerCategoryId === TMDB_MEDIA_CATEGORY_ID ? (
                        <div
                          className="tmdbCanvasPicker"
                          onPointerDown={(event) => canEdit && isActive && event.stopPropagation()}
                        >
                          <div className="tmdbSearchBar">
                            <label className="srOnly" htmlFor={`tmdb-q-${item.id}`}>
                              Search movies and TV shows
                            </label>
                            <input
                              id={`tmdb-q-${item.id}`}
                              className="tmdbSearchInput"
                              type="text"
                              inputMode="search"
                              autoComplete="off"
                              spellCheck={false}
                              enterKeyHint="search"
                              placeholder={
                                theme === "minimal"
                                  ? "Type to search movies or TV…"
                                  : "TYPE TO SEARCH MOVIES OR TV"
                              }
                              value={tmdbSearchQuery}
                              onChange={(event) => setTmdbSearchQuery(event.target.value)}
                              aria-busy={tmdbSearchBusy}
                            />
                            {tmdbSearchBusy ? (
                              <span className="tmdbSearchStatus" aria-live="polite">
                                {theme === "minimal" ? "Searching…" : "SEARCHING…"}
                              </span>
                            ) : null}
                          </div>
                          {tmdbMessage ? (
                            <p className="tmdbSearchMessage" role="status">
                              {tmdbMessage}
                            </p>
                          ) : null}
                          {tmdbSearchResults.length > 0 ? (
                            <ul className="tmdbHitList" aria-live="polite" aria-relevant="additions text">
                              {tmdbSearchResults.map((hit) => (
                                <li key={tmdbHitBusyKey(hit)} className="tmdbHit">
                                  <div className="tmdbHitMain">
                                    {hit.poster_path ? (
                                      <img
                                        className="tmdbHitThumb"
                                        src={`https://image.tmdb.org/t/p/w92${hit.poster_path}`}
                                        alt=""
                                      />
                                    ) : (
                                      <span className="tmdbHitThumb tmdbHitThumb--empty" aria-hidden />
                                    )}
                                    <span className="tmdbHitText">
                                      <span className="tmdbHitTitleRow">
                                        <span className="tmdbHitTitle">{hit.title}</span>
                                        <span
                                          className="tmdbHitKind"
                                          data-kind={hit.media_type}
                                        >
                                          {hit.media_type === "tv"
                                            ? "TV"
                                            : theme === "minimal"
                                              ? "Film"
                                              : "FILM"}
                                        </span>
                                      </span>
                                      {hit.release_date ? (
                                        <span className="tmdbHitYear">
                                          {hit.release_date.slice(0, 4)}
                                        </span>
                                      ) : null}
                                    </span>
                                  </div>
                                  <button
                                    className="tmdbHitAdd"
                                    type="button"
                                    disabled={
                                      !hit.poster_path || tmdbAddBusyKey === tmdbHitBusyKey(hit)
                                    }
                                    onClick={() => void addMoviePosterFromTmdb(hit)}
                                  >
                                    {tmdbAddBusyKey === tmdbHitBusyKey(hit)
                                      ? theme === "minimal"
                                        ? "Adding…"
                                        : "ADDING…"
                                      : theme === "minimal"
                                        ? "Add poster"
                                        : "ADD POSTER"}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          <p className="tmdbAttribution">
                            Movie and TV data courtesy of{" "}
                            <a
                              href="https://www.themoviedb.org/"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              TMDB
                            </a>
                            .
                          </p>
                        </div>
                      ) : null}
                      {canEdit &&
                      isActive &&
                      item.id === OPEN_LIBRARY_BOOKS_CATEGORY_ID &&
                      openLibraryPickerCategoryId === OPEN_LIBRARY_BOOKS_CATEGORY_ID ? (
                        <div
                          className="tmdbCanvasPicker"
                          onPointerDown={(event) => canEdit && isActive && event.stopPropagation()}
                        >
                          <div className="tmdbSearchBar">
                            <label className="srOnly" htmlFor={`ol-q-${item.id}`}>
                              Search books
                            </label>
                            <input
                              id={`ol-q-${item.id}`}
                              className="tmdbSearchInput"
                              type="text"
                              inputMode="search"
                              autoComplete="off"
                              spellCheck={false}
                              enterKeyHint="search"
                              placeholder={
                                theme === "minimal"
                                  ? "Type to search books…"
                                  : "TYPE TO SEARCH BOOKS"
                              }
                              value={openLibrarySearchQuery}
                              onChange={(event) => setOpenLibrarySearchQuery(event.target.value)}
                              aria-busy={openLibrarySearchBusy}
                            />
                            {openLibrarySearchBusy ? (
                              <span className="tmdbSearchStatus" aria-live="polite">
                                {theme === "minimal" ? "Searching…" : "SEARCHING…"}
                              </span>
                            ) : null}
                          </div>
                          {openLibraryMessage ? (
                            <p className="tmdbSearchMessage" role="status">
                              {openLibraryMessage}
                            </p>
                          ) : null}
                          {openLibrarySearchResults.length > 0 ? (
                            <ul
                              className="tmdbHitList"
                              aria-live="polite"
                              aria-relevant="additions text"
                            >
                              {openLibrarySearchResults.map((hit) => (
                                <li key={openLibraryHitBusyKey(hit)} className="tmdbHit">
                                  <div className="tmdbHitMain">
                                    {hit.cover_i != null ? (
                                      <img
                                        className="tmdbHitThumb"
                                        src={`/api/openlibrary/cover?id=${hit.cover_i}&size=S`}
                                        alt=""
                                      />
                                    ) : (
                                      <span
                                        className="tmdbHitThumb tmdbHitThumb--empty"
                                        aria-hidden
                                      />
                                    )}
                                    <span className="tmdbHitText">
                                      <span className="tmdbHitTitleRow">
                                        <span className="tmdbHitTitle">{hit.title}</span>
                                        <span className="tmdbHitKind" data-kind="book">
                                          {theme === "minimal" ? "Book" : "BOOK"}
                                        </span>
                                      </span>
                                      {hit.author_name.length > 0 ? (
                                        <span className="tmdbHitYear">
                                          {hit.author_name.slice(0, 2).join(
                                            theme === "minimal" ? ", " : " · ",
                                          )}
                                          {hit.author_name.length > 2
                                            ? theme === "minimal"
                                              ? "…"
                                              : "…"
                                            : ""}
                                        </span>
                                      ) : null}
                                      {hit.first_publish_year != null ? (
                                        <span className="tmdbHitYear">
                                          {hit.author_name.length > 0
                                            ? theme === "minimal"
                                              ? " · "
                                              : " — "
                                            : ""}
                                          {hit.first_publish_year}
                                        </span>
                                      ) : null}
                                    </span>
                                  </div>
                                  <button
                                    className="tmdbHitAdd"
                                    type="button"
                                    disabled={
                                      hit.cover_i == null ||
                                      openLibraryAddBusyKey === openLibraryHitBusyKey(hit)
                                    }
                                    onClick={() => void addBookCoverFromOpenLibrary(hit)}
                                  >
                                    {openLibraryAddBusyKey === openLibraryHitBusyKey(hit)
                                      ? theme === "minimal"
                                        ? "Adding…"
                                        : "ADDING…"
                                      : theme === "minimal"
                                        ? "Add cover"
                                        : "ADD COVER"}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          <p className="tmdbAttribution">
                            Book data courtesy of{" "}
                            <a
                              href="https://openlibrary.org/"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Open Library
                            </a>
                            .
                          </p>
                        </div>
                      ) : null}
                      <span
                        className="imageCanvas"
                        onPointerDown={clearCanvasSelection}
                        onContextMenu={(event) => {
                          if (canEdit) event.preventDefault();
                        }}
                      >
                        {isBooksCarousel ? (
                          boardImages.length > 0 ? (
                            <div
                              className="bookCarousel"
                              onPointerDown={(event) =>
                                onBookCarouselPointerDown(
                                  event,
                                  imageKey,
                                  boardImages.length,
                                  bookCarouselIndex,
                                )
                              }
                              onPointerMove={onBookCarouselPointerMove}
                              onPointerUp={finishBookCarouselDrag}
                              onPointerCancel={finishBookCarouselDrag}
                            >
                              {boardImages.map((image, coverIndex) => {
                                const distance = shortestSignedDistance(
                                  bookCarouselIndex,
                                  coverIndex,
                                  boardImages.length,
                                );
                                const hidden = Math.abs(distance) > 3;
                                const catalogPage = catalogExternalPageForImage(image, theme);
                                const active = coverIndex === bookCarouselIndex;
                                return (
                                  <span
                                    key={image.id}
                                    className="bookCarouselCard"
                                    data-active={active ? "true" : undefined}
                                    data-hidden={hidden ? "true" : undefined}
                                    style={
                                      {
                                        "--book-offset": distance,
                                      } as CSSProperties
                                    }
                                    onClick={() => {
                                      if (Date.now() < suppressBookCarouselClickUntilRef.current) return;
                                      setBookCarouselIndexByBoard((prev) => ({
                                        ...prev,
                                        [imageKey]: coverIndex,
                                      }));
                                    }}
                                  >
                                    <img
                                      className="bookCarouselCardImg"
                                      src={image.src}
                                      alt=""
                                      draggable={false}
                                    />
                                    {canEdit && active ? (
                                      <span
                                        className="bookCarouselControls"
                                        onPointerDown={(event) => event.stopPropagation()}
                                      >
                                        {catalogPage ? (
                                          <a
                                            className="imageControl imageControl--external"
                                            href={catalogPage.href}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            aria-label={catalogExternalLinkAriaLabel(
                                              catalogPage.source,
                                              theme,
                                            )}
                                          >
                                            <CanvasExternalLinkGlyph />
                                          </a>
                                        ) : null}
                                        <button
                                          className="imageControl"
                                          type="button"
                                          aria-label="Delete image"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            void removeImage(imageKey, image.id);
                                          }}
                                        >
                                          x
                                        </button>
                                      </span>
                                    ) : null}
                                  </span>
                                );
                              })}
                              {boardImages.length > 1 ? (
                                <div className="bookCarouselNav">
                                  <span className="bookCarouselCounter" aria-live="polite">
                                    {bookCarouselIndex + 1} / {boardImages.length}
                                  </span>
                                </div>
                              ) : null}
                            </div>
                          ) : null
                        ) : (
                          boardImages.map((image) => {
                            const catalogPage = catalogExternalPageForImage(image, theme);
                            const canvasImg = (
                              <img className="canvasImage" src={image.src} alt="" draggable={false} />
                            );
                            return (
                              <span
                                key={image.id}
                                className="imageItem"
                                data-selected={canEdit && selectedImageId === image.id}
                                onClick={(event) => {
                                  if (canEdit) event.stopPropagation();
                                }}
                                style={
                                  {
                                    left: `${image.x}%`,
                                    top: `${image.y}%`,
                                    width: `${image.width}%`,
                                    "--image-rotation": `${image.rotation}deg`,
                                  } as CSSProperties
                                }
                                onPointerDown={(event) => startDrag(event, imageKey, image.id)}
                              >
                                {!canEdit && catalogPage ? (
                                  <a
                                    className="canvasImageTmdbLink"
                                    href={catalogPage.href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(event) => event.stopPropagation()}
                                    onPointerDown={(event) => event.stopPropagation()}
                                  >
                                    {canvasImg}
                                  </a>
                                ) : (
                                  canvasImg
                                )}
                                {canEdit ? (
                                  <>
                                    <span
                                      className="imageControls"
                                      onPointerDown={(event) => event.stopPropagation()}
                                    >
                                      {catalogPage ? (
                                        <a
                                          className="imageControl imageControl--external"
                                          href={catalogPage.href}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          aria-label={catalogExternalLinkAriaLabel(catalogPage.source, theme)}
                                          onPointerDown={(event) => event.stopPropagation()}
                                        >
                                          <CanvasExternalLinkGlyph />
                                        </a>
                                      ) : null}
                                      <button
                                        className="imageControl"
                                        type="button"
                                        aria-label="Rotate left"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          rotateImage(imageKey, image.id, -15);
                                        }}
                                      >
                                        -15
                                      </button>
                                      <button
                                        className="imageControl"
                                        type="button"
                                        aria-label="Rotate right"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          rotateImage(imageKey, image.id, 15);
                                        }}
                                      >
                                        +15
                                      </button>
                                      <button
                                        className="imageControl"
                                        type="button"
                                        aria-label="Delete image"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void removeImage(imageKey, image.id);
                                        }}
                                      >
                                        x
                                      </button>
                                    </span>
                                    <span
                                      className="resizeHandle"
                                      aria-hidden="true"
                                      onPointerDown={(event) => startResize(event, imageKey, image.id)}
                                    />
                                  </>
                                ) : null}
                              </span>
                            );
                          })
                        )}
                      </span>
                    </div>
                  ) : variant === "links" ? (
                    <div
                      className="textBoardSurface textBoardSurface--links"
                      onPointerDown={(event) => canEdit && isActive && event.stopPropagation()}
                    >
                      {canEdit &&
                      isActive &&
                      item.id === RESTAURANTS_NOMINATIM_CATEGORY_ID &&
                      nominatimPickerCategoryId === RESTAURANTS_NOMINATIM_CATEGORY_ID ? (
                        <div
                          className="tmdbCanvasPicker nominatimCanvasPicker"
                          onPointerDown={(event) => canEdit && isActive && event.stopPropagation()}
                        >
                          <form
                            className="nominatimSearchForm"
                            onPointerDown={(event) => event.stopPropagation()}
                            onSubmit={(event) => {
                              event.preventDefault();
                              void runNominatimSearch();
                            }}
                          >
                            <div className="tmdbSearchBar">
                              <label className="srOnly" htmlFor={`nominatim-q-${item.id}`}>
                                Search for a place
                              </label>
                              <input
                                id={`nominatim-q-${item.id}`}
                                className="tmdbSearchInput"
                                type="text"
                                inputMode="search"
                                autoComplete="off"
                                spellCheck={false}
                                enterKeyHint="search"
                                placeholder="Place or restaurant name…"
                                value={nominatimQuery}
                                onChange={(event) => setNominatimQuery(event.target.value)}
                                aria-busy={nominatimSearchBusy}
                              />
                              <button
                                className="tmdbSearchSubmit"
                                type="submit"
                                disabled={nominatimSearchBusy}
                              >
                                {theme === "minimal" ? "Search" : "SEARCH"}
                              </button>
                              {nominatimSearchBusy ? (
                                <span className="tmdbSearchStatus" aria-live="polite">
                                  {theme === "minimal" ? "Searching…" : "SEARCHING…"}
                                </span>
                              ) : null}
                            </div>
                          </form>
                          {nominatimMessage ? (
                            <p className="tmdbSearchMessage" role="status">
                              {nominatimMessage}
                            </p>
                          ) : null}
                          {nominatimResults.length > 0 ? (
                            <ul
                              className="tmdbHitList"
                              aria-live="polite"
                              aria-relevant="additions text"
                            >
                              {nominatimResults.map((hit) => (
                                <li key={nominatimHitBusyKey(hit)} className="tmdbHit">
                                  <div className="tmdbHitMain">
                                    {hit.thumb_url ? (
                                      <img
                                        className="tmdbHitThumb nominatimHitThumb"
                                        src={hit.thumb_url}
                                        alt=""
                                        referrerPolicy="no-referrer"
                                      />
                                    ) : (
                                      <span
                                        className="tmdbHitThumb tmdbHitThumb--empty nominatimHitIcon"
                                        aria-hidden
                                      >
                                        <span className="nominatimHitIconInner">⌖</span>
                                      </span>
                                    )}
                                    <span className="tmdbHitText">
                                      <span className="tmdbHitTitleRow">
                                        <span className="tmdbHitTitle">
                                          {placeTitleFromNominatimHit(hit)}
                                        </span>
                                        <span className="tmdbHitKind" data-kind="place">
                                          {[hit.class, hit.type].filter(Boolean).join(" · ") ||
                                            (theme === "minimal" ? "Place" : "PLACE")}
                                        </span>
                                      </span>
                                      <span className="tmdbHitYear nominatimHitMeta">
                                        {hit.display_name}
                                      </span>
                                    </span>
                                  </div>
                                  <button
                                    className="tmdbHitAdd"
                                    type="button"
                                    disabled={nominatimAddBusyKey === nominatimHitBusyKey(hit)}
                                    onClick={() => void addPlaceFromNominatimHit(hit)}
                                  >
                                    {nominatimAddBusyKey === nominatimHitBusyKey(hit)
                                      ? theme === "minimal"
                                        ? "Adding…"
                                        : "ADDING…"
                                      : theme === "minimal"
                                        ? "Add link"
                                        : "ADD LINK"}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ) : null}
                      {canEdit &&
                      isActive &&
                      linkComposerOpen &&
                      item.id !== RESTAURANTS_NOMINATIM_CATEGORY_ID ? (
                        <form
                          className="linkComposer"
                          onPointerDown={(event) => event.stopPropagation()}
                          onSubmit={(event) => {
                            event.preventDefault();
                            addLinkFromDraft(item.id);
                          }}
                        >
                          <label className="srOnly" htmlFor={`link-url-${item.id}`}>
                            Link URL
                          </label>
                          <input
                            id={`link-url-${item.id}`}
                            className="linkComposerInput linkComposerInput--url"
                            type="url"
                            inputMode="url"
                            autoComplete="url"
                            placeholder={theme === "minimal" ? "Paste a URL" : "PASTE A URL"}
                            value={linkDraft.url}
                            onChange={(event) =>
                              setLinkDraft((d) => ({ ...d, url: event.target.value }))
                            }
                          />
                          <label className="srOnly" htmlFor={`link-title-${item.id}`}>
                            Optional title
                          </label>
                          <input
                            id={`link-title-${item.id}`}
                            className="linkComposerInput"
                            type="text"
                            placeholder={theme === "minimal" ? "Title (optional)" : "TITLE (OPTIONAL)"}
                            value={linkDraft.title}
                            onChange={(event) =>
                              setLinkDraft((d) => ({ ...d, title: event.target.value }))
                            }
                          />
                          <label className="srOnly" htmlFor={`link-note-${item.id}`}>
                            Optional note
                          </label>
                          <input
                            id={`link-note-${item.id}`}
                            className="linkComposerInput"
                            type="text"
                            placeholder={theme === "minimal" ? "Note (optional)" : "NOTE (OPTIONAL)"}
                            value={linkDraft.note}
                            onChange={(event) =>
                              setLinkDraft((d) => ({ ...d, note: event.target.value }))
                            }
                          />
                          <button className="textBoardSubmit" type="submit">
                            {theme === "minimal" ? "Save link" : "SAVE LINK"}
                          </button>
                        </form>
                      ) : null}
                      {boardLinks.length > 0 ? (
                        <ul className="linkCardList">
                          {boardLinks.map((entry) => (
                            <li key={entry.id} className="linkCard">
                              <a
                                className="linkCardAnchor"
                                href={entry.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {entry.thumbUrl ? (
                                  <img
                                    className="linkCardThumb"
                                    src={entry.thumbUrl}
                                    alt=""
                                    loading="lazy"
                                    referrerPolicy="no-referrer"
                                  />
                                ) : null}
                                <span className="linkCardHost">{linkHostname(entry.url)}</span>
                                <span className="linkCardTitle">
                                  {linkDisplayHeading(entry.url, entry.title)}
                                </span>
                                <span className="linkCardUrl" title={entry.url}>
                                  {entry.url}
                                </span>
                              </a>
                              {entry.note.trim() ? (
                                <p className="linkCardNote">{entry.note}</p>
                              ) : null}
                              {canEdit ? (
                                <button
                                  className="linkCardRemove"
                                  type="button"
                                  aria-label="Remove link"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void removeLinkEntry(imageKey, entry.id);
                                  }}
                                >
                                  ×
                                </button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : (
                    <div
                      className="textBoardSurface textBoardSurface--quotes"
                      onPointerDown={(event) => canEdit && isActive && event.stopPropagation()}
                    >
                      {canEdit && isActive && quoteComposerOpen ? (
                        <form
                          className="quoteComposer"
                          onPointerDown={(event) => event.stopPropagation()}
                          onSubmit={(event) => {
                            event.preventDefault();
                            addQuoteFromDraft(item.id);
                          }}
                        >
                          <label className="srOnly" htmlFor={`quote-text-${item.id}`}>
                            Quote text
                          </label>
                          <textarea
                            id={`quote-text-${item.id}`}
                            className="quoteComposerTextarea"
                            rows={3}
                            placeholder={
                              theme === "minimal" ? "A line worth keeping…" : "A LINE WORTH KEEPING…"
                            }
                            value={quoteDraft.text}
                            onChange={(event) =>
                              setQuoteDraft((d) => ({ ...d, text: event.target.value }))
                            }
                          />
                          <label className="srOnly" htmlFor={`quote-source-${item.id}`}>
                            Source (optional)
                          </label>
                          <input
                            id={`quote-source-${item.id}`}
                            className="quoteComposerSource"
                            type="text"
                            placeholder={
                              theme === "minimal" ? "Source (optional)" : "SOURCE (OPTIONAL)"
                            }
                            value={quoteDraft.source}
                            onChange={(event) =>
                              setQuoteDraft((d) => ({ ...d, source: event.target.value }))
                            }
                          />
                          <button className="textBoardSubmit" type="submit">
                            {theme === "minimal" ? "Save quote" : "SAVE QUOTE"}
                          </button>
                        </form>
                      ) : null}
                      {boardQuotesList.length > 0 ? (
                        <ul className="quoteCardList">
                          {boardQuotesList.map((entry) => (
                            <li key={entry.id} className="quoteCard">
                              <span className="quoteCardRail" aria-hidden="true" />
                              <div className="quoteCardMain">
                                <blockquote className="quoteCardBody">{entry.text}</blockquote>
                                {entry.source.trim() ? (
                                  <cite className="quoteCardSource">{entry.source}</cite>
                                ) : null}
                              </div>
                              {canEdit ? (
                                <button
                                  className="quoteCardRemove"
                                  type="button"
                                  aria-label="Remove quote"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void removeQuoteEntry(imageKey, entry.id);
                                  }}
                                >
                                  ×
                                </button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  )}
                </span>
              </span>
            </article>
          );
        })}
      </section>
      ) : null}
    </main>
  );
}

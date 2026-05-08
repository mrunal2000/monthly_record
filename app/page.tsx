"use client";

import type { CSSProperties, ChangeEvent, FormEvent, PointerEvent } from "react";
import {
  useCallback,
  useEffect,
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
import { FAVORITES_BUCKET, FAVORITES_TABLE, supabase } from "./lib/supabase";

type Category = {
  id: string;
  label: string;
  note: string;
  color: string;
  textColor: string;
};

const CATEGORIES_STORAGE_KEY = "monthly-record-categories";

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
    id: "food",
    label: "FOOD",
    note: "Add meals, places, recipes, cravings, and favorite bites.",
    color: "var(--category-food)",
    textColor: "var(--category-on-dark)",
  },
];

type CanvasImage = {
  id: string;
  src: string;
  storagePath?: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
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

function categoryIdFromBoardKey(boardKey: string) {
  const dash = boardKey.indexOf("-");
  if (dash === -1) return "";
  return boardKey.slice(dash + 1);
}

function colorsForCategoryIndex(index: number) {
  const def = DEFAULT_CATEGORIES[index % DEFAULT_CATEGORIES.length];
  return def ? { color: def.color, textColor: def.textColor } : { color: DEFAULT_CATEGORIES[0].color, textColor: DEFAULT_CATEGORIES[0].textColor };
}

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
  const [theme, setTheme] = useState<ThemeName>("brutalist");
  const [categories, setCategories] = useState<Category[]>(DEFAULT_CATEGORIES);
  const [categoriesHydrated, setCategoriesHydrated] = useState(false);
  const [newFrameName, setNewFrameName] = useState("");
  const imagesByBoardRef = useRef<Record<string, CanvasImage[]>>({});
  const categoriesRef = useRef<Category[]>(DEFAULT_CATEGORIES);
  const titleStableRef = useRef<Record<string, string>>({});
  const frameArticleRefs = useRef<(HTMLElement | null)[]>([]);
  /** Skip first mobile `scrollIntoView` so refresh keeps content below fixed chrome (padding-top). */
  const skipMobileFrameScrollIntoViewRef = useRef(true);
  const dragRef = useRef<DragState | null>(null);
  const lastDragAppliedRef = useRef<{
    imageKey: string;
    imageId: string;
    x: number;
    y: number;
    width: number;
  } | null>(null);
  const activeMonth = months[activeMonthIndex];
  const canEdit = Boolean(user);
  const wideLayout = useWideLayout(768);

  const pastMonthBoardImageCounts = useMemo(
    () =>
      months.map((monthMeta) =>
        categories.reduce(
          (sum, cat) => sum + (imagesByBoard[`${monthMeta.id}-${cat.id}`]?.length ?? 0),
          0,
        ),
      ),
    [categories, imagesByBoard],
  );

  const clearCanvasSelection = useCallback(() => {
    setSelectedImageId(null);
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setAccountMenuOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [accountMenuOpen]);

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
    window.localStorage.setItem("monthly-record-theme", nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
  }

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  function openFrame(index: number) {
    if (index === activeIndex) {
      return;
    }
    setOpenDirection(index > activeIndex ? "ltr" : "rtl");
    setActiveIndex(index);
    setSelectedImageId(null);
  }

  useEffect(() => {
    if (wideLayout) {
      skipMobileFrameScrollIntoViewRef.current = true;
    }
  }, [wideLayout]);

  useEffect(() => {
    if (wideLayout) return;
    const el = frameArticleRefs.current[activeIndex];
    if (!el) return;
    if (skipMobileFrameScrollIntoViewRef.current) {
      skipMobileFrameScrollIntoViewRef.current = false;
      return;
    }
    const id = window.requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(id);
  }, [activeIndex, wideLayout, activeMonth.id]);

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
        next.push({
          id,
          label: label.trim() || "UNTITLED",
          note,
          color,
          textColor,
        });
      }
      if (next.length > 0) setCategories(next);
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

      const { data, error } = await supabase
        .from(FAVORITES_TABLE)
        .select("id, board_key, month_id, category_index, category_label, image_url, storage_path, x, y, width, rotation")
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Could not load Supabase favorites:", error.message);
        setSaveStatus("LOAD ERROR");
        return;
      }

      const grouped = (data as FavoriteItemRow[]).reduce<Record<string, CanvasImage[]>>(
        (boards, row) => {
          if (!row.image_url) return boards;
          const key = canonicalBoardKey(row.board_key);
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
  }, []);

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

  function addFrameFromInput() {
    if (!canEdit) return;

    const name = newFrameName.trim();
    if (!name) return;

    const { color, textColor } = colorsForCategoryIndex(categoriesRef.current.length);
    const id = crypto.randomUUID();
    setCategories((prev) => {
      const next = [
        ...prev,
        {
          id,
          label: theme === "minimal" ? formatMinimalSentenceCase(name) : name.toUpperCase(),
          note: "",
          color,
          textColor,
        },
      ];
      setActiveIndex(next.length - 1);
      setOpenDirection("ltr");

      return next;
    });

    setNewFrameName("");
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

    if (!supabase) {
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

  async function addImages(event: ChangeEvent<HTMLInputElement>, categoryId: string) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    if (!canEdit) {
      setSaveStatus("SIGN IN TO EDIT");
      event.target.value = "";
      return;
    }

    const imageKey = boardKey(categoryId);

    try {
      setSaveStatus(supabase ? "SAVING" : "LOCAL ONLY");
      const existing = imagesByBoardRef.current[imageKey] ?? [];
      const nextImages = await Promise.all(
        files.map(async (file, fileIndex) => {
          const uploaded = await uploadImageFile(file, imageKey);

          return {
            id: crypto.randomUUID(),
            src: uploaded.src,
            storagePath: uploaded.storagePath,
            x: 12 + ((existing.length + fileIndex) % 4) * 9,
            y: 28 + ((existing.length + fileIndex) % 3) * 10,
            width: 30,
            rotation: 0,
          };
        }),
      );

      setImagesByBoard((current) => {
        const next = {
          ...current,
          [imageKey]: [...(current[imageKey] ?? []), ...nextImages],
        };
        imagesByBoardRef.current = next;

        return next;
      });

      await Promise.all(
        nextImages.map((entry) => saveImageRecord(imageKey, categoryId, entry)),
      );
    } catch (error) {
      console.error(
        "Could not upload image:",
        error instanceof Error ? error.message : String(error),
      );
      setSaveStatus("SAVE ERROR");
    }

    event.target.value = "";
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
  }

  function leaveEditFlow() {
    const url = new URL(window.location.href);
    url.searchParams.delete("edit");
    const search = url.searchParams.toString();
    window.history.replaceState({}, "", `${url.pathname}${search ? `?${search}` : ""}`);
    setEditMode(false);
  }

  return (
    <main
      className={["page", user && "page--signedIn", canEdit && wideLayout && "page--desktopEditChrome"]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={clearCanvasSelection}
    >
      <FavoritesAiAgent
        months={months}
        categories={categories}
        imagesByBoard={imagesByBoard}
        theme={theme}
      />
      <header className="mobileAppChrome">
        <div className="mobileAppChrome__topBand">
          <label className="themePicker" onPointerDown={(event) => event.stopPropagation()}>
            <span className="themePickerPrefix">Theme:</span>
            <select
              className="themeSelect"
              aria-label="Visual theme"
              value={theme}
              onChange={(event) => updateTheme(event.target.value as ThemeName)}
            >
              {themes.map((themeOption) => (
                <option key={themeOption.id} value={themeOption.id}>
                  {theme === "minimal"
                    ? formatMinimalSentenceCase(themeOption.label)
                    : themeOption.label}
                </option>
              ))}
            </select>
          </label>
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

      {canEdit ? (
        <div className="frameManagerBar" onPointerDown={(event) => event.stopPropagation()}>
          <label className="srOnly" htmlFor="new-frame-name">
            New frame name
          </label>
          <input
            id="new-frame-name"
            className="frameManagerInput"
            type="text"
            placeholder="New frame name"
            value={newFrameName}
            onChange={(event) => setNewFrameName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addFrameFromInput();
              }
            }}
          />
          <button className="frameManagerButton" type="button" onClick={() => addFrameFromInput()}>
            ADD FRAME
          </button>
        </div>
      ) : null}

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
          const boardImages = imagesByBoard[imageKey] ?? [];
          const imageCount = boardImages.length;
          const selectedImage = boardImages.find((image) => image.id === selectedImageId);

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
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openFrame(index);
                }
              }}
            >
              <span className="frameLabel">
                {`${
                  theme === "minimal" ? formatMinimalSentenceCase(item.label) : item.label
                }[${imageCount}]`}
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
                              const nextLabel =
                                theme === "minimal"
                                  ? formatMinimalSentenceCase(trimmed)
                                  : trimmed.toUpperCase();
                              const prevRaw = (
                                titleStableRef.current[item.id] ?? ""
                              ).trim();
                              const prevCompared =
                                theme === "minimal"
                                  ? formatMinimalSentenceCase(prevRaw)
                                  : prevRaw.toUpperCase();
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
                    {canEdit ? (
                      <span className="canvasActions">
                        {selectedImage ? (
                          <button
                            className="deleteSelectedButton"
                            type="button"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              void removeImage(imageKey, selectedImage.id);
                            }}
                          >
                            DELETE SELECTED
                          </button>
                        ) : null}
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
                      </span>
                    ) : null}
                  </span>
                  <span
                    className="imageCanvas"
                    onPointerDown={clearCanvasSelection}
                    onContextMenu={(event) => {
                      if (canEdit) event.preventDefault();
                    }}
                  >
                    {boardImages.map((image) => (
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
                        <img className="canvasImage" src={image.src} alt="" draggable={false} />
                        {canEdit ? (
                          <>
                            <span
                              className="imageControls"
                              onPointerDown={(event) => event.stopPropagation()}
                            >
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
                    ))}
                  </span>
                </span>
              </span>
            </article>
          );
        })}
      </section>
    </main>
  );
}

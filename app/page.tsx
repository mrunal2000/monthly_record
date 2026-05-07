"use client";

import { HalftoneCmyk } from "@paper-design/shaders-react";
import type { CSSProperties, ChangeEvent, FormEvent, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
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

type BoardImageItem = {
  id: string;
  kind: "image";
  src: string;
  storagePath?: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
};

type BoardTextItem = {
  id: string;
  kind: "text";
  body: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
};

type BoardItem = BoardImageItem | BoardTextItem;

type FavoriteItemRow = {
  id: string;
  board_key: string;
  month_id: string;
  category_index: number;
  category_label: string;
  image_url: string | null;
  storage_path: string | null;
  item_kind?: string | null;
  text_content?: string | null;
  x: number;
  y: number;
  width: number;
  rotation: number;
};

type DragState = {
  mode: "move" | "resize";
  paneKey: string;
  itemId: string;
  offsetX: number;
  offsetY: number;
};

type ThemeName = "gallery" | "ink" | "bnw";
type OpenDirection = "ltr" | "rtl";

const themes: { id: ThemeName; label: string }[] = [
  { id: "gallery", label: "GALLERY" },
  { id: "ink", label: "INK" },
  { id: "bnw", label: "BNW" },
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

function rowToBoardItem(row: FavoriteItemRow): BoardItem | null {
  const shared = {
    id: row.id,
    x: row.x,
    y: row.y,
    width: row.width,
    rotation: row.rotation,
  };
  if (row.item_kind === "text") {
    return { ...shared, kind: "text", body: row.text_content ?? "" };
  }
  const src = row.image_url;
  if (!src) return null;
  return {
    ...shared,
    kind: "image",
    src,
    storagePath: row.storage_path ?? undefined,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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

function getActiveFrameWidthToken(frameCount: number) {
  const collapsedFrames = frameCount - 1;
  const collapsedWidth = Array.from(
    { length: collapsedFrames },
    () => "var(--collapsed-width)",
  ).join(" - ");
  const collapsedGaps = Array.from(
    { length: collapsedFrames },
    () => "var(--accordion-gap)",
  ).join(" - ");

  return `calc(100% - ${collapsedWidth} - ${collapsedGaps})`;
}

export default function Home() {
  const currentMonthIndex = getCurrentMonthIndex();
  const [activeMonthIndex, setActiveMonthIndex] = useState(currentMonthIndex);
  const [activeIndex, setActiveIndex] = useState(0);
  const [openDirection, setOpenDirection] = useState<OpenDirection>("ltr");
  const [itemsByBoard, setItemsByBoard] = useState<Record<string, BoardItem[]>>({});
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [saveStatus, setSaveStatus] = useState(supabase ? "SUPABASE CONNECTED" : "LOCAL ONLY");
  const [user, setUser] = useState<User | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [theme, setTheme] = useState<ThemeName>("gallery");
  const [categories, setCategories] = useState<Category[]>(DEFAULT_CATEGORIES);
  const [categoriesHydrated, setCategoriesHydrated] = useState(false);
  const [newFrameName, setNewFrameName] = useState("");
  const itemsByBoardRef = useRef<Record<string, BoardItem[]>>({});
  const categoriesRef = useRef<Category[]>(DEFAULT_CATEGORIES);
  const titleStableRef = useRef<Record<string, string>>({});
  const dragRef = useRef<DragState | null>(null);
  const activeMonth = months[activeMonthIndex];
  const canEdit = Boolean(user);

  useEffect(() => {
    setNow(new Date());
    setEditMode(new URLSearchParams(window.location.search).get("edit") === "1");
    const storedTheme = window.localStorage.getItem("monthly-record-theme") as ThemeName | null;
    if (storedTheme && themes.some((themeOption) => themeOption.id === storedTheme)) {
      setTheme(storedTheme);
    }
    const interval = window.setInterval(() => setNow(new Date()), 1000);

    return () => window.clearInterval(interval);
  }, []);

  function updateTheme(nextTheme: ThemeName) {
    setTheme(nextTheme);
    window.localStorage.setItem("monthly-record-theme", nextTheme);
  }

  function openFrame(index: number) {
    if (index !== activeIndex) {
      setOpenDirection(index > activeIndex ? "ltr" : "rtl");
    }

    setActiveIndex(index);
    setSelectedItemId(null);
  }

  useEffect(() => {
    itemsByBoardRef.current = itemsByBoard;
  }, [itemsByBoard]);

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
        .select(
          "id, board_key, month_id, category_index, category_label, image_url, storage_path, item_kind, text_content, x, y, width, rotation",
        )
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Could not load Supabase favorites:", error.message);
        setSaveStatus("LOAD ERROR");
        return;
      }

      const grouped = (data as FavoriteItemRow[]).reduce<Record<string, BoardItem[]>>(
        (boards, row) => {
          const key = canonicalBoardKey(row.board_key);
          const boardItem = rowToBoardItem(row as FavoriteItemRow);
          if (!boardItem) return boards;
          boards[key] = [...(boards[key] ?? []), boardItem];

          return boards;
        },
        {},
      );

      itemsByBoardRef.current = grouped;
      setItemsByBoard(grouped);
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

  function countImagesForMonth(monthIndex: number) {
    return categories.reduce(
      (sum, cat) => sum + (itemsByBoard[boardKey(cat.id, monthIndex)]?.length ?? 0),
      0,
    );
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
          label: name.toUpperCase(),
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

    if (!supabase) {
      return {
        src: URL.createObjectURL(file),
        storagePath: undefined,
      };
    }

    const storagePath = `${imageKey}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
    const { error } = await supabase.storage.from(FAVORITES_BUCKET).upload(storagePath, file);

    if (error) throw error;

    const { data } = supabase.storage.from(FAVORITES_BUCKET).getPublicUrl(storagePath);

    return {
      src: data.publicUrl,
      storagePath,
    };
  }

  async function saveBoardItemRecord(paneKey: string, categoryId: string, boardItem: BoardItem) {
    if (!canEdit) {
      setSaveStatus("SIGN IN TO EDIT");
      return;
    }

    if (!supabase) {
      setSaveStatus("LOCAL ONLY");
      return;
    }

    if (boardItem.kind === "image" && !boardItem.storagePath) {
      setSaveStatus("LOCAL ONLY");
      return;
    }

    setSaveStatus("SAVING");
    const monthId = monthIdFromBoardKey(paneKey);
    const cats = categoriesRef.current;
    const categoryIndex = cats.findIndex((c) => c.id === categoryId);
    const categoryLabel =
      cats[categoryIndex >= 0 ? categoryIndex : 0]?.label ??
      cats[0]?.label ??
      "?";

    const baseRow = {
      id: boardItem.id,
      board_key: canonicalBoardKey(paneKey),
      month_id: monthId,
      category_index: categoryIndex >= 0 ? categoryIndex : 0,
      category_label: categoryLabel,
      x: boardItem.x,
      y: boardItem.y,
      width: boardItem.width,
      rotation: boardItem.rotation,
      updated_at: new Date().toISOString(),
    };

    let error: { message: string } | null = null;

    if (boardItem.kind === "image") {
      const result = await supabase.from(FAVORITES_TABLE).upsert({
        ...baseRow,
        item_kind: "image",
        image_url: boardItem.src,
        storage_path: boardItem.storagePath as string,
        text_content: null,
      });
      error = result.error;
    } else {
      const result = await supabase.from(FAVORITES_TABLE).upsert({
        ...baseRow,
        item_kind: "text",
        image_url: null,
        storage_path: null,
        text_content: boardItem.body,
      });
      error = result.error;
    }

    if (error) {
      console.error("Could not save board item:", error.message);
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
      const existing = itemsByBoardRef.current[imageKey] ?? [];
      const nextImages = await Promise.all(
        files.map(async (file, fileIndex) => {
          const uploaded = await uploadImageFile(file, imageKey);

          return {
            id: crypto.randomUUID(),
            kind: "image" as const,
            src: uploaded.src,
            storagePath: uploaded.storagePath,
            x: 12 + ((existing.length + fileIndex) % 4) * 9,
            y: 28 + ((existing.length + fileIndex) % 3) * 10,
            width: 30,
            rotation: 0,
          };
        }),
      );

      setItemsByBoard((current) => {
        const next = {
          ...current,
          [imageKey]: [...(current[imageKey] ?? []), ...nextImages],
        };
        itemsByBoardRef.current = next;

        return next;
      });

      await Promise.all(
        nextImages.map((entry) => saveBoardItemRecord(imageKey, categoryId, entry)),
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

  function addCanvasText(categoryId: string) {
    if (!canEdit) {
      setSaveStatus("SIGN IN TO EDIT");
      return;
    }

    const paneKey = boardKey(categoryId);
    const existing = itemsByBoardRef.current[paneKey] ?? [];
    const nextItem: BoardTextItem = {
      id: crypto.randomUUID(),
      kind: "text",
      body: "",
      x: 14 + (existing.length % 4) * 7,
      y: 26 + (existing.length % 3) * 9,
      width: 38,
      rotation: 0,
    };

    setItemsByBoard((current) => {
      const next = {
        ...current,
        [paneKey]: [...(current[paneKey] ?? []), nextItem],
      };
      itemsByBoardRef.current = next;

      return next;
    });

    setSelectedItemId(nextItem.id);
    void saveBoardItemRecord(paneKey, categoryId, nextItem);
  }

  function updateTextItemBody(paneKey: string, itemId: string, body: string) {
    setItemsByBoard((current) => {
      const next = {
        ...current,
        [paneKey]: (current[paneKey] ?? []).map((it) =>
          it.id === itemId && it.kind === "text" ? { ...it, body } : it,
        ),
      };
      itemsByBoardRef.current = next;

      return next;
    });
  }

  function startDrag(event: PointerEvent<HTMLElement>, paneKey: string, itemId: string) {
    event.stopPropagation();
    if (!canEdit) return;

    const imageRect = event.currentTarget.getBoundingClientRect();
    setSelectedItemId(itemId);
    dragRef.current = {
      mode: "move",
      paneKey,
      itemId,
      offsetX: event.clientX - imageRect.left,
      offsetY: event.clientY - imageRect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startResize(event: PointerEvent<HTMLSpanElement>, paneKey: string, itemId: string) {
    event.stopPropagation();
    if (!canEdit) return;

    setSelectedItemId(itemId);
    dragRef.current = {
      mode: "resize",
      paneKey,
      itemId,
      offsetX: 0,
      offsetY: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateItemFromPointer(event: PointerEvent<HTMLElement>) {
    if (!canEdit) return;

    const drag = dragRef.current;
    const canvas = event.currentTarget.closest(".imageCanvas");
    if (!drag || !canvas) return;

    event.stopPropagation();
    const canvasRect = canvas.getBoundingClientRect();
    const itemRect = drag.mode === "move" ? event.currentTarget.getBoundingClientRect() : null;

    setItemsByBoard((current) => {
      const next = {
        ...current,
        [drag.paneKey]: (current[drag.paneKey] ?? []).map((boardItem) =>
          boardItem.id === drag.itemId
            ? getUpdatedBoardItem(boardItem, event, canvasRect, drag, itemRect)
            : boardItem,
        ),
      };
      itemsByBoardRef.current = next;

      return next;
    });
  }

  function getUpdatedBoardItem(
    boardItem: BoardItem,
    event: PointerEvent<HTMLElement>,
    canvasRect: DOMRect,
    drag: DragState,
    itemRect: DOMRect | null,
  ) {
    if (drag.mode === "resize") {
      const pointerX = ((event.clientX - canvasRect.left) / canvasRect.width) * 100;
      const nextWidth = pointerX - boardItem.x;
      return {
        ...boardItem,
        width: clamp(nextWidth, 12, Math.max(12, 100 - boardItem.x)),
      };
    }

    const itemWidth =
      itemRect?.width ?? ((boardItem.width / 100) * canvasRect.width);
    const itemHeight = itemRect?.height ?? 0;
    const x = ((event.clientX - canvasRect.left - drag.offsetX) / canvasRect.width) * 100;
    const y = ((event.clientY - canvasRect.top - drag.offsetY) / canvasRect.height) * 100;
    const maxX = ((canvasRect.width - itemWidth) / canvasRect.width) * 100;
    const maxY = ((canvasRect.height - itemHeight) / canvasRect.height) * 100;

    return { ...boardItem, x: clamp(x, 0, maxX), y: clamp(y, 0, maxY) };
  }

  function stopDrag(event: PointerEvent<HTMLElement>) {
    event.stopPropagation();
    if (!canEdit) return;

    const drag = dragRef.current;

    if (drag) {
      const boardItem = itemsByBoardRef.current[drag.paneKey]?.find(
        (entry) => entry.id === drag.itemId,
      );
      const categoryId = categoryIdFromBoardKey(drag.paneKey);

      if (boardItem && categoryId) {
        void saveBoardItemRecord(drag.paneKey, categoryId, boardItem);
      }
    }

    dragRef.current = null;
  }

  function rotateBoardItem(paneKey: string, itemId: string, amount: number) {
    if (!canEdit) return;

    const categoryId = categoryIdFromBoardKey(paneKey);
    const prev = itemsByBoardRef.current[paneKey]?.find((entry) => entry.id === itemId);
    const updated = prev ? { ...prev, rotation: prev.rotation + amount } : null;

    setItemsByBoard((current) => {
      const next = {
        ...current,
        [paneKey]: (current[paneKey] ?? []).map((boardItem) =>
          boardItem.id === itemId
            ? { ...boardItem, rotation: boardItem.rotation + amount }
            : boardItem,
        ),
      };
      itemsByBoardRef.current = next;

      return next;
    });

    if (updated && categoryId) {
      void saveBoardItemRecord(paneKey, categoryId, updated);
    }
  }

  function removeBoardItem(paneKey: string, itemId: string) {
    if (!canEdit) return;

    const removed = itemsByBoardRef.current[paneKey]?.find((entry) => entry.id === itemId);

    setItemsByBoard((current) => {
      const next = {
        ...current,
        [paneKey]: (current[paneKey] ?? []).filter((boardItem) => boardItem.id !== itemId),
      };
      itemsByBoardRef.current = next;

      return next;
    });

    if (supabase) {
      setSaveStatus("SAVING");
      void supabase.from(FAVORITES_TABLE).delete().eq("id", itemId);

      if (removed?.kind === "image" && removed.storagePath) {
        void supabase.storage.from(FAVORITES_BUCKET).remove([removed.storagePath]);
      }

      setSaveStatus("SAVED");
    }

    if (selectedItemId === itemId) setSelectedItemId(null);
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !authEmail.trim()) return;

    setAuthMessage("CHECK EMAIL");
    const { error } = await supabase.auth.signInWithOtp({
      email: authEmail.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}?edit=1`,
      },
    });

    if (error) {
      console.error("Could not sign in:", error.message);
      setAuthMessage("SIGN IN ERROR");
      return;
    }

    setAuthMessage("MAGIC LINK SENT");
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setSelectedItemId(null);
  }

  return (
    <main className="page" data-theme={theme} onPointerDown={() => setSelectedItemId(null)}>
      <time className="topTimestamp" dateTime={now?.toISOString()}>
        {now
          ? new Intl.DateTimeFormat("en", {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
            }).format(now)
          : ""}
      </time>
      {editMode || user ? (
        <form className="authBar" onSubmit={signIn}>
          {user ? (
            <>
              <span className="authUser">{user.email}</span>
              <button className="authButton" type="button" onClick={signOut}>
                SIGN OUT
              </button>
            </>
          ) : (
            <>
              <input
                className="authInput"
                type="email"
                placeholder="email to edit"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
              />
              <button className="authButton" type="submit">
                SIGN IN
              </button>
              {authMessage ? <span className="authMessage">{authMessage}</span> : null}
            </>
          )}
        </form>
      ) : null}
      <label className="themePicker" onPointerDown={(event) => event.stopPropagation()}>
        <span className="srOnly">Theme</span>
        <select
          className="themeSelect"
          value={theme}
          onChange={(event) => updateTheme(event.target.value as ThemeName)}
        >
          {themes.map((themeOption) => (
            <option key={themeOption.id} value={themeOption.id}>
              {themeOption.label}
            </option>
          ))}
        </select>
      </label>

      <nav className="monthRail" aria-label="Monthly favorite boards">
        {months.map((month, index) => {
          const pastCount =
            index < currentMonthIndex ? countImagesForMonth(index) : null;
          return (
            <button
              key={month.id}
              className="monthButton"
              data-active={index === activeMonthIndex}
              data-current={index === currentMonthIndex}
              type="button"
              aria-label={
                pastCount !== null
                  ? `${month.label}, ${pastCount === 1 ? "1 item" : `${pastCount} items`}`
                  : month.label
              }
              onClick={() => {
                setActiveMonthIndex(index);
                setSelectedItemId(null);
              }}
            >
              <span aria-hidden="true">{month.label}</span>
              {pastCount !== null ? (
                <span className="monthCountBadge" aria-hidden="true">{`[${pastCount}]`}</span>
              ) : null}
            </button>
          );
        })}
      </nav>

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
        aria-label={`${activeMonth.label} favorite category cards`}
        style={{ "--active-frame-width": getActiveFrameWidthToken(categories.length) } as CSSProperties}
      >
        {categories.map((item, index) => {
          const isActive = index === activeIndex;
          const paneKey = boardKey(item.id);
          const boardItems = itemsByBoard[paneKey] ?? [];
          const selectedItem = boardItems.find((entry) => entry.id === selectedItemId);

          return (
            <article
              key={item.id}
              className="frame"
              data-active={isActive}
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
              <span className="frameLabel">{item.label}</span>
              <span className="frameRect">
                <span className="frameContent" aria-hidden={!isActive}>
                  <span className="canvasHeader">
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
                              const nextLabel = trimmed.toUpperCase();
                              const prevLabel = (
                                titleStableRef.current[item.id] ?? ""
                              ).trim().toUpperCase();
                              if (prevLabel !== nextLabel) {
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
                          <span className="frameTitle">{item.label}</span>
                          <span className="frameNote">{item.note}</span>
                        </>
                      )}
                    </span>
                    {canEdit ? (
                      <span className="canvasActions">
                        {selectedItem ? (
                          <button
                            className="deleteSelectedButton"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              removeBoardItem(paneKey, selectedItem.id);
                            }}
                          >
                            DELETE SELECTED
                          </button>
                        ) : null}
                        <button
                          className="addTextButton"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            addCanvasText(item.id);
                          }}
                        >
                          ADD TEXT
                        </button>
                        <label className="addButton" onClick={(event) => event.stopPropagation()}>
                          <span aria-hidden="true">+</span>
                          <span className="srOnly">Add images to {item.label}</span>
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
                  <span className="imageCanvas" onPointerDown={() => setSelectedItemId(null)}>
                    {boardItems.map((boardItem) =>
                      boardItem.kind === "image" ? (
                        <span
                          key={boardItem.id}
                          className="imageItem"
                          data-selected={canEdit && selectedItemId === boardItem.id}
                          style={
                            {
                              left: `${boardItem.x}%`,
                              top: `${boardItem.y}%`,
                              width: `${boardItem.width}%`,
                              "--image-rotation": `${boardItem.rotation}deg`,
                            } as CSSProperties
                          }
                          onPointerDown={(event) => startDrag(event, paneKey, boardItem.id)}
                          onPointerMove={updateItemFromPointer}
                          onPointerUp={stopDrag}
                          onPointerCancel={stopDrag}
                        >
                          <img className="canvasImage" src={boardItem.src} alt="" draggable={false} />
                          {theme === "bnw" ? (
                            <HalftoneCmyk
                              size={0.08}
                              gridNoise={0.01}
                              type="ink"
                              softness={1}
                              contrast={1}
                              gainC={0.3}
                              gainM={0}
                              gainY={0.2}
                              gainK={0}
                              floodC={0.15}
                              floodM={0}
                              floodY={0}
                              floodK={0}
                              scale={1}
                              image={boardItem.src}
                              grainSize={0.5}
                              fit="cover"
                              colorBack="#00000000"
                              colorC="#00B4FF"
                              colorM="#FC519F"
                              colorY="#FFD800"
                              colorK="#231F20"
                              className="imageShader"
                              style={{ backgroundColor: "#FBFAF5", height: "100%", width: "100%" }}
                            />
                          ) : null}
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
                                    rotateBoardItem(paneKey, boardItem.id, -15);
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
                                    rotateBoardItem(paneKey, boardItem.id, 15);
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
                                    removeBoardItem(paneKey, boardItem.id);
                                  }}
                                >
                                  x
                                </button>
                              </span>
                              <span
                                className="resizeHandle"
                                aria-hidden="true"
                                onPointerDown={(event) => startResize(event, paneKey, boardItem.id)}
                                onPointerMove={updateItemFromPointer}
                                onPointerUp={stopDrag}
                                onPointerCancel={stopDrag}
                              />
                            </>
                          ) : null}
                        </span>
                      ) : (
                        <span
                          key={boardItem.id}
                          className="imageItem canvasTextItem"
                          data-selected={canEdit && selectedItemId === boardItem.id}
                          style={
                            {
                              left: `${boardItem.x}%`,
                              top: `${boardItem.y}%`,
                              width: `${boardItem.width}%`,
                              "--image-rotation": `${boardItem.rotation}deg`,
                            } as CSSProperties
                          }
                          onPointerDown={(event) => {
                            if (
                              event.target instanceof Element &&
                              event.target.closest(".canvasTextInput")
                            ) {
                              return;
                            }
                            startDrag(event, paneKey, boardItem.id);
                          }}
                          onPointerMove={updateItemFromPointer}
                          onPointerUp={stopDrag}
                          onPointerCancel={stopDrag}
                        >
                          {!canEdit ? (
                            <div className="canvasTextReadonly">
                              {boardItem.body.trim()
                                ? boardItem.body
                                : "\u00a0"}
                            </div>
                          ) : selectedItemId === boardItem.id ? (
                            <textarea
                              className="canvasTextInput"
                              aria-label="Canvas note"
                              placeholder="Write something…"
                              value={boardItem.body}
                              onChange={(event) =>
                                updateTextItemBody(paneKey, boardItem.id, event.target.value)
                              }
                              onPointerDown={(event) => event.stopPropagation()}
                              onBlur={() => {
                                const categoryId = categoryIdFromBoardKey(paneKey);
                                const refreshed = itemsByBoardRef.current[paneKey]?.find(
                                  (entry) => entry.id === boardItem.id && entry.kind === "text",
                                );
                                if (refreshed && refreshed.kind === "text" && categoryId) {
                                  void saveBoardItemRecord(paneKey, categoryId, refreshed);
                                }
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              className="canvasTextReadonly canvasTextTapToEdit"
                              onPointerDown={(event) => {
                                event.stopPropagation();
                                setSelectedItemId(boardItem.id);
                              }}
                            >
                              {boardItem.body.trim() ? boardItem.body : "Tap to write"}
                            </button>
                          )}
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
                                    rotateBoardItem(paneKey, boardItem.id, -15);
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
                                    rotateBoardItem(paneKey, boardItem.id, 15);
                                  }}
                                >
                                  +15
                                </button>
                                <button
                                  className="imageControl"
                                  type="button"
                                  aria-label="Delete text"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    removeBoardItem(paneKey, boardItem.id);
                                  }}
                                >
                                  x
                                </button>
                              </span>
                              <span
                                className="resizeHandle"
                                aria-hidden="true"
                                onPointerDown={(event) => startResize(event, paneKey, boardItem.id)}
                                onPointerMove={updateItemFromPointer}
                                onPointerUp={stopDrag}
                                onPointerCancel={stopDrag}
                              />
                            </>
                          ) : null}
                        </span>
                      ),
                    )}
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

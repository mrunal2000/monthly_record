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
  const [imagesByBoard, setImagesByBoard] = useState<Record<string, CanvasImage[]>>({});
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
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
  const imagesByBoardRef = useRef<Record<string, CanvasImage[]>>({});
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
    setSelectedImageId(null);
  }

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

  function countImagesForMonth(monthIndex: number) {
    return categories.reduce(
      (sum, cat) => sum + (imagesByBoard[boardKey(cat.id, monthIndex)]?.length ?? 0),
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

    const imageRect = event.currentTarget.getBoundingClientRect();
    setSelectedImageId(imageId);
    dragRef.current = {
      mode: "move",
      imageKey,
      imageId,
      offsetX: event.clientX - imageRect.left,
      offsetY: event.clientY - imageRect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startResize(event: PointerEvent<HTMLSpanElement>, imageKey: string, imageId: string) {
    event.stopPropagation();
    if (!canEdit) return;

    setSelectedImageId(imageId);
    dragRef.current = {
      mode: "resize",
      imageKey,
      imageId,
      offsetX: 0,
      offsetY: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateImageFromPointer(event: PointerEvent<HTMLElement>) {
    if (!canEdit) return;

    const drag = dragRef.current;
    const canvas = event.currentTarget.closest(".imageCanvas");
    if (!drag || !canvas) return;

    event.stopPropagation();
    const canvasRect = canvas.getBoundingClientRect();
    const itemRect = drag.mode === "move" ? event.currentTarget.getBoundingClientRect() : null;

    setImagesByBoard((current) => {
      const next = {
        ...current,
        [drag.imageKey]: (current[drag.imageKey] ?? []).map((image) =>
          image.id === drag.imageId
            ? getUpdatedImage(image, event, canvasRect, drag, itemRect)
            : image,
        ),
      };
      imagesByBoardRef.current = next;

      return next;
    });
  }

  function getUpdatedImage(
    image: CanvasImage,
    event: PointerEvent<HTMLElement>,
    canvasRect: DOMRect,
    drag: DragState,
    itemRect: DOMRect | null,
  ) {
    if (drag.mode === "resize") {
      const pointerX = ((event.clientX - canvasRect.left) / canvasRect.width) * 100;
      const nextWidth = pointerX - image.x;
      return { ...image, width: clamp(nextWidth, 16, Math.max(16, 100 - image.x)) };
    }

    const itemWidth = itemRect?.width ?? (image.width / 100) * canvasRect.width;
    const itemHeight = itemRect?.height ?? 0;
    const x = ((event.clientX - canvasRect.left - drag.offsetX) / canvasRect.width) * 100;
    const y = ((event.clientY - canvasRect.top - drag.offsetY) / canvasRect.height) * 100;
    const maxX = ((canvasRect.width - itemWidth) / canvasRect.width) * 100;
    const maxY = ((canvasRect.height - itemHeight) / canvasRect.height) * 100;

    return { ...image, x: clamp(x, 0, maxX), y: clamp(y, 0, maxY) };
  }

  function stopDrag(event: PointerEvent<HTMLElement>) {
    event.stopPropagation();
    if (!canEdit) return;

    const drag = dragRef.current;

    if (drag) {
      const image = imagesByBoardRef.current[drag.imageKey]?.find(
        (currentImage) => currentImage.id === drag.imageId,
      );
      const categoryId = categoryIdFromBoardKey(drag.imageKey);

      if (image && categoryId) {
        void saveImageRecord(drag.imageKey, categoryId, image);
      }
    }

    dragRef.current = null;
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

  function removeImage(imageKey: string, imageId: string) {
    if (!canEdit) return;

    const image = imagesByBoardRef.current[imageKey]?.find(
      (currentImage) => currentImage.id === imageId,
    );

    setImagesByBoard((current) => {
      const next = {
        ...current,
        [imageKey]: (current[imageKey] ?? []).filter((currentImage) => currentImage.id !== imageId),
      };
      imagesByBoardRef.current = next;

      return next;
    });

    if (supabase) {
      setSaveStatus("SAVING");
      void supabase.from(FAVORITES_TABLE).delete().eq("id", imageId);

      if (image?.storagePath) {
        void supabase.storage.from(FAVORITES_BUCKET).remove([image.storagePath]);
      }

      setSaveStatus("SAVED");
    }

    if (selectedImageId === imageId) setSelectedImageId(null);
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
    setSelectedImageId(null);
  }

  return (
    <main className="page" data-theme={theme} onPointerDown={() => setSelectedImageId(null)}>
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
          const isPastMonth = index < currentMonthIndex;
          const pastCount = isPastMonth ? countImagesForMonth(index) : null;
          const showEmptyPastBadge = pastCount !== null && pastCount === 0;
          return (
            <button
              key={month.id}
              className="monthButton"
              data-active={index === activeMonthIndex}
              data-current={index === currentMonthIndex}
              type="button"
              aria-label={
                showEmptyPastBadge ? `${month.label}, empty` : month.label
              }
              onClick={() => {
                setActiveMonthIndex(index);
                setSelectedImageId(null);
              }}
            >
              <span aria-hidden="true">{month.label}</span>
              {showEmptyPastBadge ? (
                <span className="monthCountBadge" aria-hidden="true">
                  [0]
                </span>
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
          const imageKey = boardKey(item.id);
          const boardImages = imagesByBoard[imageKey] ?? [];
          const imageCount = boardImages.length;
          const selectedImage = boardImages.find((image) => image.id === selectedImageId);

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
              <span className="frameLabel">{`${item.label}[${imageCount}]`}</span>
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
                        {selectedImage ? (
                          <button
                            className="deleteSelectedButton"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              removeImage(imageKey, selectedImage.id);
                            }}
                          >
                            DELETE SELECTED
                          </button>
                        ) : null}
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
                  <span className="imageCanvas" onPointerDown={() => setSelectedImageId(null)}>
                    {boardImages.map((image) => (
                      <span
                        key={image.id}
                        className="imageItem"
                        data-selected={canEdit && selectedImageId === image.id}
                        style={
                          {
                            left: `${image.x}%`,
                            top: `${image.y}%`,
                            width: `${image.width}%`,
                            "--image-rotation": `${image.rotation}deg`,
                          } as CSSProperties
                        }
                        onPointerDown={(event) => startDrag(event, imageKey, image.id)}
                        onPointerMove={updateImageFromPointer}
                        onPointerUp={stopDrag}
                        onPointerCancel={stopDrag}
                      >
                        <img className="canvasImage" src={image.src} alt="" draggable={false} />
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
                            image={image.src}
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
                                  removeImage(imageKey, image.id);
                                }}
                              >
                                x
                              </button>
                            </span>
                            <span
                              className="resizeHandle"
                              aria-hidden="true"
                              onPointerDown={(event) => startResize(event, imageKey, image.id)}
                              onPointerMove={updateImageFromPointer}
                              onPointerUp={stopDrag}
                              onPointerCancel={stopDrag}
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

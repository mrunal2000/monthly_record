"use client";

import type { CSSProperties, ChangeEvent, FormEvent, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { FAVORITES_BUCKET, FAVORITES_TABLE, supabase } from "./lib/supabase";

type Item = {
  label: string;
  color: string;
  textColor: string;
  note: string;
};

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
  image_url: string;
  storage_path: string;
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

const items: Item[] = [
  {
    label: "MEDIA",
    color: "#4C54CC",
    textColor: "#FFFFFF",
    note: "Add stills, posters, scenes, and anything from what you watched.",
  },
  {
    label: "BOOKS",
    color: "#D55192",
    textColor: "#FFFFFF",
    note: "Add covers, spreads, quotes, and references you want to arrange.",
  },
  {
    label: "MISC",
    color: "#6E3C8A",
    textColor: "#FFFFFF",
    note: "Add anything that does not fit neatly anywhere else.",
  },
  {
    label: "WISHLIST",
    color: "#7B85BA",
    textColor: "#07101F",
    note: "Add things you want, are considering, or want to remember.",
  },
  {
    label: "FOOD",
    color: "#2F7D4C",
    textColor: "#FFFFFF",
    note: "Add meals, places, recipes, cravings, and favorite bites.",
  },
];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getCurrentMonthIndex() {
  return new Date().getMonth();
}

export default function Home() {
  const currentMonthIndex = getCurrentMonthIndex();
  const [activeMonthIndex, setActiveMonthIndex] = useState(currentMonthIndex);
  const [activeIndex, setActiveIndex] = useState(0);
  const [imagesByBoard, setImagesByBoard] = useState<Record<string, CanvasImage[]>>({});
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [saveStatus, setSaveStatus] = useState(supabase ? "SUPABASE CONNECTED" : "LOCAL ONLY");
  const [user, setUser] = useState<User | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [editMode, setEditMode] = useState(false);
  const imagesByBoardRef = useRef<Record<string, CanvasImage[]>>({});
  const dragRef = useRef<DragState | null>(null);
  const activeMonth = months[activeMonthIndex];
  const canEdit = Boolean(user);

  useEffect(() => {
    setNow(new Date());
    setEditMode(new URLSearchParams(window.location.search).get("edit") === "1");
    const interval = window.setInterval(() => setNow(new Date()), 1000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    imagesByBoardRef.current = imagesByBoard;
  }, [imagesByBoard]);

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
          boards[row.board_key] = [
            ...(boards[row.board_key] ?? []),
            {
              id: row.id,
              src: row.image_url,
              storagePath: row.storage_path,
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

  function boardKey(categoryIndex: number, monthIndex = activeMonthIndex) {
    return `${months[monthIndex].id}-${categoryIndex}`;
  }

  function categoryIndexFromBoardKey(imageKey: string) {
    return Number(imageKey.split("-").at(-1));
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

  async function saveImageRecord(
    imageKey: string,
    categoryIndex: number,
    image: CanvasImage,
  ) {
    if (!canEdit) {
      setSaveStatus("SIGN IN TO EDIT");
      return;
    }

    if (!supabase || !image.storagePath) {
      setSaveStatus("LOCAL ONLY");
      return;
    }

    setSaveStatus("SAVING");
    const monthId = imageKey.split("-")[0];
    const { error } = await supabase.from(FAVORITES_TABLE).upsert({
      id: image.id,
      board_key: imageKey,
      month_id: monthId,
      category_index: categoryIndex,
      category_label: items[categoryIndex].label,
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

  async function addImages(event: ChangeEvent<HTMLInputElement>, categoryIndex: number) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    if (!canEdit) {
      setSaveStatus("SIGN IN TO EDIT");
      event.target.value = "";
      return;
    }

    const imageKey = boardKey(categoryIndex);

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
        nextImages.map((image) => saveImageRecord(imageKey, categoryIndex, image)),
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

  function startDrag(
    event: PointerEvent<HTMLElement>,
    imageKey: string,
    imageId: string,
  ) {
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

  function startResize(
    event: PointerEvent<HTMLSpanElement>,
    imageKey: string,
    imageId: string,
  ) {
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
      const categoryIndex = categoryIndexFromBoardKey(drag.imageKey);

      if (image && Number.isFinite(categoryIndex)) {
        void saveImageRecord(drag.imageKey, categoryIndex, image);
      }
    }

    dragRef.current = null;
  }

  function rotateImage(imageKey: string, imageId: string, amount: number) {
    if (!canEdit) return;

    const categoryIndex = categoryIndexFromBoardKey(imageKey);
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

    if (updatedImage && Number.isFinite(categoryIndex)) {
      void saveImageRecord(imageKey, categoryIndex, updatedImage);
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
        [imageKey]: (current[imageKey] ?? []).filter((image) => image.id !== imageId),
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
    <main className="page">
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

      <nav className="monthRail" aria-label="Monthly favorite boards">
        {months.map((month, index) => (
          <button
            key={month.id}
            className="monthButton"
            data-active={index === activeMonthIndex}
            data-current={index === currentMonthIndex}
            type="button"
            onClick={() => {
              setActiveMonthIndex(index);
              setSelectedImageId(null);
            }}
          >
            {month.label}
          </button>
        ))}
      </nav>

      <section
        key={activeMonth.id}
        className="accordion"
        aria-label={`${activeMonth.label} favorite category cards`}
      >
        {items.map((item, index) => {
          const isActive = index === activeIndex;
          const imageKey = boardKey(index);
          const boardImages = imagesByBoard[imageKey] ?? [];
          const selectedImage = boardImages.find((image) => image.id === selectedImageId);

          return (
            <article
              key={item.label}
              className="frame"
              data-active={isActive}
              style={
                {
                  "--frame-color": item.color,
                  "--frame-text-color": item.textColor,
                } as CSSProperties
              }
              role="button"
              tabIndex={0}
              aria-selected={isActive}
              onClick={() => setActiveIndex(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setActiveIndex(index);
                }
              }}
            >
              <span className="frameLabel">{item.label}</span>
              <span className="frameRect">
                <span className="frameContent" aria-hidden={!isActive}>
                  <span className="canvasHeader">
                    <span>
                      <span className="frameTitle">{item.label}</span>
                      <span className="frameNote">
                        {activeMonth.label} favorites. {item.note}
                      </span>
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
                            onChange={(event) => addImages(event, index)}
                          />
                        </label>
                      </span>
                    ) : null}
                  </span>
                  <span className="imageCanvas">
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
                        {canEdit ? (
                          <>
                            <span className="imageControls" onPointerDown={(event) => event.stopPropagation()}>
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

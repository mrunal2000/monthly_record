"use client";

import type { CSSProperties, ChangeEvent, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";

type Item = {
  label: string;
  color: string;
  textColor: string;
  note: string;
};

type CanvasImage = {
  id: string;
  src: string;
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
  const dragRef = useRef<DragState | null>(null);
  const activeMonth = months[activeMonthIndex];

  useEffect(() => {
    setNow(new Date());
    const interval = window.setInterval(() => setNow(new Date()), 1000);

    return () => window.clearInterval(interval);
  }, []);

  function boardKey(categoryIndex: number, monthIndex = activeMonthIndex) {
    return `${months[monthIndex].id}-${categoryIndex}`;
  }

  function addImages(event: ChangeEvent<HTMLInputElement>, categoryIndex: number) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    const imageKey = boardKey(categoryIndex);

    setImagesByBoard((current) => {
      const existing = current[imageKey] ?? [];
      const nextImages = files.map((file, fileIndex) => ({
        id: `${imageKey}-${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
        src: URL.createObjectURL(file),
        x: 12 + ((existing.length + fileIndex) % 4) * 9,
        y: 28 + ((existing.length + fileIndex) % 3) * 10,
        width: 30,
        rotation: 0,
      }));

      return {
        ...current,
        [imageKey]: [...existing, ...nextImages],
      };
    });

    event.target.value = "";
  }

  function startDrag(
    event: PointerEvent<HTMLElement>,
    imageKey: string,
    imageId: string,
  ) {
    event.stopPropagation();
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
    const drag = dragRef.current;
    const canvas = event.currentTarget.closest(".imageCanvas");
    if (!drag || !canvas) return;

    event.stopPropagation();
    const canvasRect = canvas.getBoundingClientRect();
    const itemRect = drag.mode === "move" ? event.currentTarget.getBoundingClientRect() : null;

    setImagesByBoard((current) => ({
      ...current,
      [drag.imageKey]: (current[drag.imageKey] ?? []).map((image) =>
        image.id === drag.imageId
          ? getUpdatedImage(image, event, canvasRect, drag, itemRect)
          : image,
      ),
    }));
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
    dragRef.current = null;
  }

  function rotateImage(imageKey: string, imageId: string, amount: number) {
    setImagesByBoard((current) => ({
      ...current,
      [imageKey]: (current[imageKey] ?? []).map((image) =>
        image.id === imageId ? { ...image, rotation: image.rotation + amount } : image,
      ),
    }));
  }

  function removeImage(imageKey: string, imageId: string) {
    setImagesByBoard((current) => ({
      ...current,
      [imageKey]: (current[imageKey] ?? []).filter((image) => image.id !== imageId),
    }));
    if (selectedImageId === imageId) setSelectedImageId(null);
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
                  <span className="imageCanvas">
                    {boardImages.map((image) => (
                      <span
                        key={image.id}
                        className="imageItem"
                        data-selected={selectedImageId === image.id}
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

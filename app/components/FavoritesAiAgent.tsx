"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildAgentFavoritesContext,
  buildAgentVisionImageRefs,
  type AgentCategoryMeta,
  type AgentFavoriteImageSnap,
  type AgentMonthMeta,
} from "../lib/agentContext";
import AiChatMarkdown from "./AiChatMarkdown";

type ThemeName = "paper" | "brutalist" | "minimal";

type ChatTurn = { role: "user" | "assistant"; content: string };

const FAB_SIZE = 56;
const FAB_STORAGE_KEY = "favorites-ai-fab-pos";
const DRAG_THRESHOLD_PX = 12;

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

/** Position the chat panel so the critter reads as the top corner (above the panel corners, z-index-wise): top-left anchor when FAB sits in the left half of the viewport, otherwise top-right. Prefer opening below with a slight overlap onto the FAB; flip above centered if there is almost no vertical room below. */
function computeAiPanelRect(
  fabLeft: number,
  fabTop: number,
  fabSize: number,
  vw: number,
  vh: number,
): { left: number; top: number; width: number; maxHeight: number } {
  const pad = 14;
  const gap = 14;
  const cornerOverlap = Math.min(22, Math.floor(fabSize * 0.38));
  const panelW = Math.min(420, vw - pad * 2);
  const fabCx = fabLeft + fabSize / 2;
  const fabRight = fabLeft + fabSize;
  const capH = Math.min(560, Math.floor(vh * 0.72));
  const minReadable = 180;

  /** Panel lines up along the FAB’s left edge (critter visually top-leading) vs along the right edge (top-trailing); pick from horizontal center. */
  const anchorCritterTopLeft = fabCx <= vw / 2;

  const cornerHorizontalLeft = (): number =>
    clamp(
      anchorCritterTopLeft ? fabLeft : fabRight - panelW,
      pad,
      Math.max(pad, vw - panelW - pad),
    );

  const centeredHorizontalLeft = (): number =>
    clamp(fabCx - panelW / 2, pad, Math.max(pad, vw - panelW - pad));

  /** Panel top edge nudges under the FAB so the critter feels “pinned” on the corner. */
  const belowTop = fabTop + fabSize - cornerOverlap;
  const maxHBelow = vh - pad - belowTop;

  const maxHAboveIdeal = Math.min(capH, Math.max(0, fabTop - pad - gap));
  const aboveTop = fabTop - maxHAboveIdeal - gap;

  let top: number;
  let maxH: number;
  let useCornerAnchors = true;

  if (maxHBelow >= minReadable || maxHBelow >= maxHAboveIdeal) {
    top = belowTop;
    maxH = Math.min(capH, maxHBelow);
  } else if (maxHAboveIdeal >= 140) {
    top = Math.max(pad, aboveTop);
    maxH = Math.min(capH, fabTop - gap - top, vh - pad - top);
    useCornerAnchors = false;
  } else {
    top = belowTop;
    maxH = Math.min(capH, Math.max(0, vh - pad - belowTop));
  }

  maxH = Math.min(Math.max(140, maxH), capH, Math.max(0, vh - pad - top));
  top = clamp(top, pad, Math.max(pad, vh - pad - maxH));
  maxH = Math.min(maxH, vh - pad - top);

  const left = useCornerAnchors ? cornerHorizontalLeft() : centeredHorizontalLeft();

  return { left, top, width: panelW, maxHeight: Math.max(120, maxH) };
}

export type FavoritesAiAgentProps = {
  months: AgentMonthMeta[];
  categories: AgentCategoryMeta[];
  imagesByBoard: Record<string, AgentFavoriteImageSnap[]>;
  theme: ThemeName;
};

export default function FavoritesAiAgent({
  months,
  categories,
  imagesByBoard,
  theme,
}: FavoritesAiAgentProps) {
  const contextBlock = useMemo(
    () => buildAgentFavoritesContext(months, categories, imagesByBoard),
    [months, categories, imagesByBoard],
  );
  const visionRefs = useMemo(
    () => buildAgentVisionImageRefs(months, categories, imagesByBoard),
    [months, categories, imagesByBoard],
  );
  const contextStrRef = useRef(contextBlock);
  const visionRefsRef = useRef(visionRefs);
  useEffect(() => {
    contextStrRef.current = contextBlock;
    visionRefsRef.current = visionRefs;
  }, [contextBlock, visionRefs]);

  const [panelOpen, setPanelOpen] = useState(false);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const [fabPos, setFabPos] = useState<{ left: number; top: number } | null>(null);
  const fabReady = fabPos !== null;

  const dragPointerRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startLeft: number;
    startTop: number;
    moved: boolean;
  } | null>(null);
  const fabPosRef = useRef<{ left: number; top: number }>({ left: 0, top: 0 });
  const sendingRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const init = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const safeR = 12;
      const safeB = 12;
      let left = w - FAB_SIZE - safeR;
      let top = h - FAB_SIZE - safeB;

      try {
        const raw = window.localStorage.getItem(FAB_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (
            parsed &&
            typeof parsed === "object" &&
            "left" in parsed &&
            "top" in parsed &&
            typeof (parsed as { left: unknown }).left === "number" &&
            typeof (parsed as { top: unknown }).top === "number"
          ) {
            left = (parsed as { left: number; top: number }).left;
            top = (parsed as { top: number }).top;
          }
        }
      } catch {
        /* ignore bad storage */
      }

      left = clamp(left, 8, Math.max(8, w - FAB_SIZE - 8));
      top = clamp(top, 8, Math.max(8, h - FAB_SIZE - 8));
      const next = { left, top };
      fabPosRef.current = next;
      setFabPos(next);
    };

    init();
    window.addEventListener("resize", init);
    return () => window.removeEventListener("resize", init);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, panelOpen, busy]);

  useEffect(() => {
    function onEsc(event: KeyboardEvent) {
      if (event.key === "Escape") setPanelOpen(false);
    }
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, []);

  const panelRect = useMemo(() => {
    if (!panelOpen || !fabPos || typeof window === "undefined") return null;
    return computeAiPanelRect(fabPos.left, fabPos.top, FAB_SIZE, window.innerWidth, window.innerHeight);
  }, [panelOpen, fabPos]);

  const persistFab = useCallback((left: number, top: number) => {
    try {
      window.localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify({ left, top }));
    } catch {
      /* quota */
    }
  }, []);

  const onFabPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!fabPos) return;
      event.stopPropagation();
      dragPointerRef.current = {
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        startLeft: fabPos.left,
        startTop: fabPos.top,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [fabPos],
  );

  const onFabPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragPointerRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      const dx = event.clientX - drag.originX;
      const dy = event.clientY - drag.originY;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) drag.moved = true;

      if (!drag.moved) return;

      const w = window.innerWidth;
      const h = window.innerHeight;

      setFabPos((prev) => {
        if (!prev) return prev;
        const nextLeft = clamp(
          drag.startLeft + dx,
          8,
          Math.max(8, w - FAB_SIZE - 8),
        );
        const nextTop = clamp(
          drag.startTop + dy,
          8,
          Math.max(8, h - FAB_SIZE - 8),
        );
        const next = { left: nextLeft, top: nextTop };
        fabPosRef.current = next;
        return next;
      });
    },
    [],
  );

  const onFabPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragPointerRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      dragPointerRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }

      if (drag.moved) persistFab(fabPosRef.current.left, fabPosRef.current.top);
      else setPanelOpen((open) => !open);
    },
    [persistFab],
  );

  const sendChat = useCallback(async () => {
    const text = draft.trim();
    if (!text || sendingRef.current) return;

    sendingRef.current = true;
    setBusy(true);
    setErrorBanner(null);
    setDraft("");

    const userTurn: ChatTurn = { role: "user", content: text };
    const historyPayload: ChatTurn[] = [...messages, userTurn];
    setMessages(historyPayload);

    try {
      const res = await fetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: contextStrRef.current,
          visionImages: visionRefsRef.current,
          history: historyPayload,
        }),
      });
      const data: unknown = await res.json().catch(() => ({}));

      let reply = "";
      let errBody = "";

      if (data && typeof data === "object") {
        const o = data as Record<string, unknown>;
        if ("reply" in o && typeof o.reply === "string") reply = o.reply.trim();
        if ("error" in o && typeof o.error === "string") errBody = o.error;
      }

      if (!res.ok || !reply) {
        setErrorBanner(errBody || "Could not get a reply.");
        setMessages((prev) => prev.slice(0, -1));
        return;
      }

      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch {
      setErrorBanner("Network error.");
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setBusy(false);
      sendingRef.current = false;
    }
  }, [draft, messages]);

  if (!fabReady || !fabPos) return null;

  return (
    <>
      {panelOpen ? (
        <button
          type="button"
          className="aiAgentBackdrop"
          aria-label="Close assistant"
          onPointerDown={() => setPanelOpen(false)}
        />
      ) : null}

      {panelOpen ? (
        <aside
          className="aiAgentPanel"
          data-theme={theme}
          role="dialog"
          aria-label="Favorites assistant"
          aria-modal="true"
          style={
            panelRect
              ? {
                  left: panelRect.left,
                  top: panelRect.top,
                  width: panelRect.width,
                  maxHeight: panelRect.maxHeight,
                }
              : undefined
          }
          onPointerDown={(event) => event.stopPropagation()}
        >
          <header className="aiAgentPanel__head">
            <div>
              <p className="aiAgentPanel__title">Favorites assistant</p>
              <p className="aiAgentPanel__sub">Ask me anything, I know what you like</p>
            </div>
            <button
              type="button"
              className="aiAgentPanel__close"
              aria-label="Close"
              onClick={() => setPanelOpen(false)}
            >
              ×
            </button>
          </header>

          {errorBanner ? <p className="aiAgentPanel__error">{errorBanner}</p> : null}

          <div className="aiAgentPanel__thread" role="log" aria-live="polite">
            {messages.length === 0 ? (
              <p className="aiAgentPanel__empty">
                Try: &ldquo;What book should I read next based on my recent favorites?&rdquo; or
                &ldquo;What patterns do you see in my wishlist?&rdquo;
              </p>
            ) : null}
            {messages.map((m, i) => (
              <div
                key={`${m.role}-${i}-${String(m.content).slice(0, 16)}`}
                className={`aiAgentPanel__bubble aiAgentPanel__bubble--${m.role}`}
              >
                <AiChatMarkdown content={m.content} variant={m.role} />
              </div>
            ))}
            {busy ? <p className="aiAgentPanel__thinking">Thinking…</p> : null}
            <div ref={messagesEndRef} />
          </div>

          <form
            className="aiAgentPanel__form"
            onSubmit={(event) => {
              event.preventDefault();
              void sendChat();
            }}
          >
            <label className="srOnly" htmlFor="ai-agent-input">
              Message to assistant
            </label>
            <textarea
              id="ai-agent-input"
              className="aiAgentPanel__input"
              rows={2}
              placeholder="Ask about your favorites…"
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendChat();
                }
              }}
            />
            <button type="submit" className="aiAgentPanel__send" disabled={busy || !draft.trim()}>
              Send
            </button>
          </form>
        </aside>
      ) : null}

      <button
        type="button"
        className="aiAgentFab"
        data-theme={theme}
        data-thinking={busy ? "true" : undefined}
        aria-busy={busy}
        style={{ left: fabPos.left, top: fabPos.top }}
        aria-label="Open favorites assistant — drag to move"
        aria-expanded={panelOpen}
        onPointerDown={onFabPointerDown}
        onPointerMove={onFabPointerMove}
        onPointerUp={onFabPointerUp}
        onPointerCancel={onFabPointerUp}
      >
        <img
          className="aiAgentFab__img"
          src="/agent-chat-trigger.png"
          alt=""
          width={56}
          height={56}
          draggable={false}
        />
      </button>
    </>
  );
}

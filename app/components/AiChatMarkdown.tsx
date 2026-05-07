"use client";

import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type AiChatMarkdownProps = {
  content: string;
  variant: "user" | "assistant";
};

function safeRenderableUrl(url: string | undefined): string | undefined {
  if (!url || typeof url !== "string") return undefined;
  const t = url.trim();
  try {
    const parsed = new URL(t);
    if (parsed.protocol === "https:") return t;
    if (parsed.protocol === "http:") {
      const h = parsed.hostname;
      if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return t;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Renders Markdown in chat bubbles: lists, **bold**, and HTTPS images as thumbnails. */
export default function AiChatMarkdown({ content, variant }: AiChatMarkdownProps) {
  const components: Partial<Components> = {
    a: ({ href, children }) => {
      const safe = safeRenderableUrl(href);
      if (!safe)
        return <span>{children}</span>;
      return (
        <a href={safe} target="_blank" rel="noopener noreferrer" className="aiChatMarkdown__a">
          {children}
        </a>
      );
    },
    img: ({ src, alt, title }) => {
      if (typeof src !== "string") return null;

      const safe = safeRenderableUrl(src);
      if (!safe) return null;

      const label =
        typeof alt === "string" && alt.trim() ? alt.trim() : "";

      return (
        <figure className="aiChatMarkdown__figure">
          <img
            src={safe}
            alt={label || "Board image"}
            title={typeof title === "string" ? title : label || undefined}
            className="aiChatMarkdown__img"
            loading="lazy"
            decoding="async"
          />
        </figure>
      );
    },
    p: ({ children }) => <p className="aiChatMarkdown__p">{children}</p>,
    ul: ({ children }) => (
      <ul className={`aiChatMarkdown__ul aiChatMarkdown__ul--${variant}`}>{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className={`aiChatMarkdown__ol aiChatMarkdown__ol--${variant}`}>{children}</ol>
    ),
    li: ({ children }) => <li className="aiChatMarkdown__li">{children}</li>,
    strong: ({ children }) => <strong className="aiChatMarkdown__strong">{children}</strong>,
    em: ({ children }) => <em className="aiChatMarkdown__em">{children}</em>,
    h1: ({ children }) => <h4 className="aiChatMarkdown__heading">{children}</h4>,
    h2: ({ children }) => <h4 className="aiChatMarkdown__heading">{children}</h4>,
    h3: ({ children }) => <h4 className="aiChatMarkdown__heading">{children}</h4>,
    hr: () => <hr className="aiChatMarkdown__hr" />,
  };

  return (
    <div className={`aiChatMarkdown aiChatMarkdown--${variant}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

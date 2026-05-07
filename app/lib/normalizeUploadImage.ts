/**
 * iPhone uploads are often HEIC; OpenAI vision + broad browser decode want JPEG/WebP-ish.
 */
function baseFileStem(name: string) {
  return name.replace(/\.[^.]+$/, "").trim() || "image";
}

function safeStem(name: string) {
  return baseFileStem(name).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
}

export function fileLooksHeifFamily(file: File): boolean {
  const t = file.type.toLowerCase();
  return (
    t === "image/heic" ||
    t === "image/heif" ||
    /\.hei[cf]$/i.test(file.name.trim())
  );
}

export async function normalizeImageFileForStorage(file: File): Promise<File> {
  if (!fileLooksHeifFamily(file)) return file;

  const bitmap = await createImageBitmap(file);
  try {
    const maxEdge = 2400;
    const { width: w0, height: h0 } = bitmap;
    const scale = Math.min(1, maxEdge / Math.max(w0, h0, 1));
    const cw = Math.max(1, Math.round(w0 * scale));
    const ch = Math.max(1, Math.round(h0 * scale));

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d_context");

    ctx.drawImage(bitmap, 0, 0, cw, ch);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("jpeg_encode_failed"))),
        "image/jpeg",
        0.88,
      );
    });

    return new File([blob], `${safeStem(file.name)}.jpg`, { type: "image/jpeg" });
  } finally {
    bitmap.close?.();
  }
}

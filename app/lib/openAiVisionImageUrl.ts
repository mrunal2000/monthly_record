/**
 * OpenAI vision image_url fetcher supports PNG, JPEG, WEBP, GIF — not HEIC/HEIF
 * (and often fails on other rasters). Filter before sending multimodal payloads.
 *
 * https://platform.openai.com/docs/guides/images-vision
 */
export function isSupportedVisionImageUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url.trim()).pathname;
  } catch {
    return false;
  }
  const dot = pathname.lastIndexOf(".");
  if (dot === -1) return true;

  switch (pathname.slice(dot).toLowerCase()) {
    case ".heic":
    case ".heif":
    case ".tif":
    case ".tiff":
      return false;
    default:
      return true;
  }
}

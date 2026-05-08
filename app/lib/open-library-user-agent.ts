/** https://openlibrary.org/developers/api — identify the app and provide contact when possible. */
export function openLibraryUserAgent(): string {
  const email = process.env.OPEN_LIBRARY_CONTACT_EMAIL?.trim();
  if (email) return `FavoritesCollage/1.0 (${email})`;
  return "FavoritesCollage/1.0 (local-dev; set OPEN_LIBRARY_CONTACT_EMAIL)";
}

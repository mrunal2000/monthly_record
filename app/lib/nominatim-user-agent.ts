/**
 * OSMF Nominatim usage policy: identify the application with a valid User-Agent.
 * https://operations.osmfoundation.org/policies/nominatim/
 */
export function nominatimUserAgent(): string {
  const email = process.env.NOMINATIM_CONTACT_EMAIL?.trim();
  if (email) return `FavoritesCollage/1.0 (${email})`;
  return "FavoritesCollage/1.0 (local-dev; set NOMINATIM_CONTACT_EMAIL)";
}

export function nominatimContactEmail(): string | undefined {
  const e = process.env.NOMINATIM_CONTACT_EMAIL?.trim();
  return e || undefined;
}

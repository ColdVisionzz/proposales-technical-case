import { timingSafeEqual } from "node:crypto";

// Checks an `Authorization: Bearer <secret>` header in constant time. Fails closed: with no secret configured, nobody gets in.
export function bearerMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(header ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

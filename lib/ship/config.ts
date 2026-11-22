/**
 * The Internet Ship integration settings (all server-side env vars):
 *
 *   SHIP_API_URL                  Base URL of the ship site, e.g. https://ship.example.com
 *   SHIP_INTERNAL_SECRET          Shared HMAC secret (base64, >= 32 bytes); same value as the ship's
 *   SHIP_BOARDING_AUTOMATION_IDS  Comma-separated Automation ids that send boarding codes
 *
 * Read lazily so the rest of OpenReply runs unchanged when they are unset.
 */
export type ShipConfig = { apiUrl: string; secret: Buffer };

export function shipAutomationIds(): Set<string> {
  return new Set(
    (process.env.SHIP_BOARDING_AUTOMATION_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isShipAutomation(automationId: string): boolean {
  return shipAutomationIds().has(automationId);
}

/** The connection settings, or null with the reason if they are missing or invalid. */
export function shipConfig(): { ok: true; config: ShipConfig } | { ok: false; reason: string } {
  const apiUrl = process.env.SHIP_API_URL?.trim();
  const secretB64 = process.env.SHIP_INTERNAL_SECRET?.trim();
  if (!apiUrl || !secretB64) return { ok: false, reason: "SHIP_API_URL and SHIP_INTERNAL_SECRET must be set" };
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return { ok: false, reason: "SHIP_API_URL is not a valid URL" };
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocal) return { ok: false, reason: "SHIP_API_URL must use https" };
  const secret = Buffer.from(secretB64, "base64");
  if (secret.length < 32) return { ok: false, reason: "SHIP_INTERNAL_SECRET must be at least 32 bytes (base64)" };
  return { ok: true, config: { apiUrl: url.origin, secret } };
}

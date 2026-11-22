import { createHmac } from "node:crypto";
import type { z } from "zod";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signingPayload } from "./contract";
import type { ShipConfig } from "./config";

export const SHIP_REQUEST_TIMEOUT_MS = 5_000;

/**
 * A failed call to the ship. The message never includes the request or
 * response body (which can contain a boarding code), so it is safe for
 * OpenReply's logs, DmLog.errorMessage and operational events.
 */
export class ShipApiError extends Error {
  readonly kind: "network" | "timeout" | "http" | "invalid_response";
  readonly status?: number;

  constructor(kind: ShipApiError["kind"], status?: number) {
    super(`Ship API ${kind}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "ShipApiError";
    this.kind = kind;
    this.status = status;
  }

  /** Worth retrying later (BullMQ backoff): network trouble, timeouts and 5xx/429. */
  get retryable(): boolean {
    return this.kind !== "http" || this.status === undefined || this.status >= 500 || this.status === 429;
  }
}

export function sign(secret: Buffer, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(signingPayload(timestamp, rawBody)).digest("hex");
}

/** POSTs a signed JSON body to the ship and validates the JSON response with `schema`. */
export async function signedPost<T>(
  config: ShipConfig,
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  let res: Response;
  try {
    res = await fetchImpl(`${config.apiUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(config.secret, timestamp, rawBody),
      },
      body: rawBody,
      signal: AbortSignal.timeout(SHIP_REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    throw new ShipApiError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
  }
  if (!res.ok) throw new ShipApiError("http", res.status);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ShipApiError("invalid_response", res.status);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ShipApiError("invalid_response", res.status);
  return parsed.data;
}

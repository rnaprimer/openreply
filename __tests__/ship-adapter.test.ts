import { describe, it, expect, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { issueBoardingCode, reportDelivery } from "@/lib/ship/adapter";
import { ShipApiError, sign } from "@/lib/ship/client";
import { shipConfig, isShipAutomation } from "@/lib/ship/config";
import {
  applyShipPlaceholders,
  errorCodeOf,
  prepareShipBoarding,
  shipAutomationProblem,
  type ShipAutomationShape,
} from "@/lib/ship/worker";
import { INTERNAL_PATHS } from "@/lib/ship/contract";

const secret = Buffer.alloc(32, 7);
const config = { apiUrl: "https://ship.test", secret };
const input = { instagramAccountId: "ig_1", commenterId: "user_1", commentId: "comment_1", mediaId: "media_1" };
const CODE = "K7PM-4XQ2-B9RT-6NWA";
const issued = {
  status: "issued",
  invitation_id: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
  boarding_code: CODE,
  expires_at: "2026-12-01T00:00:00.000Z",
  ship_url: "https://ship.test/board",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signed requests", () => {
  it("signs timestamp.body with HMAC-SHA256 and sends the headers the ship expects", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>;
      const ts = headers["x-ship-timestamp"];
      const expected = createHmac("sha256", secret).update(`${ts}.${init!.body}`).digest("hex");
      expect(headers["x-ship-signature"]).toBe(expected);
      expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(5);
      return jsonResponse(issued);
    });
    const result = await issueBoardingCode(config, input, fetchImpl as typeof fetch);
    expect(result).toEqual(issued);
    expect(fetchImpl).toHaveBeenCalledWith(`https://ship.test${INTERNAL_PATHS.issue}`, expect.objectContaining({ method: "POST", redirect: "error" }));
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({
      instagram_account_id: "ig_1",
      instagram_user_id: "user_1",
      instagram_comment_id: "comment_1",
      instagram_media_id: "media_1",
    });
  });

  it("sign() is the documented scheme", () => {
    expect(sign(secret, "100", "{}")).toBe(createHmac("sha256", secret).update("100.{}").digest("hex"));
  });
});

describe("failures", () => {
  it("classifies network errors, timeouts, HTTP errors and bad responses without leaking bodies", async () => {
    const cases: Array<[() => Promise<Response>, string, boolean]> = [
      [async () => { throw new TypeError("fetch failed"); }, "network", true],
      [async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, "timeout", true],
      [async () => jsonResponse({ error: "x" }, 503), "http", true],
      [async () => jsonResponse({ error: "x" }, 429), "http", true],
      [async () => jsonResponse({ error: "UNAUTHORIZED" }, 401), "http", false],
      [async () => jsonResponse({ ...issued, boarding_code: "not a code" }), "invalid_response", true],
      [async () => new Response("<html>", { status: 200 }), "invalid_response", true],
    ];
    for (const [impl, kind, retryable] of cases) {
      const err = await issueBoardingCode(config, input, impl as unknown as typeof fetch).catch((e) => e);
      expect(err).toBeInstanceOf(ShipApiError);
      expect(err.kind).toBe(kind);
      expect(err.retryable).toBe(retryable);
      expect(err.message).not.toContain(CODE);
    }
  });

  it("uses a short timeout", async () => {
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ ok: true });
    });
    await reportDelivery(config, issued.invitation_id, "comment_1", "delivered", undefined, fetchImpl as typeof fetch);
  });
});

describe("config", () => {
  it("requires both settings, https (except localhost) and a 32-byte secret", () => {
    expect(shipConfig().ok).toBe(false);
    vi.stubEnv("SHIP_API_URL", "http://ship.example.com");
    vi.stubEnv("SHIP_INTERNAL_SECRET", secret.toString("base64"));
    expect(shipConfig()).toMatchObject({ ok: false, reason: expect.stringMatching(/https/) });
    vi.stubEnv("SHIP_API_URL", "http://localhost:3000");
    expect(shipConfig().ok).toBe(true);
    vi.stubEnv("SHIP_INTERNAL_SECRET", Buffer.alloc(8).toString("base64"));
    expect(shipConfig().ok).toBe(false);
  });

  it("reads automation ids from a comma-separated list", () => {
    vi.stubEnv("SHIP_BOARDING_AUTOMATION_IDS", " a1 , b2,,");
    expect(isShipAutomation("a1")).toBe(true);
    expect(isShipAutomation("b2")).toBe(true);
    expect(isShipAutomation("c3")).toBe(false);
  });
});

const goodAutomation: ShipAutomationShape = {
  id: "auto_ship",
  dmMessage: "Your boarding pass: {boarding_code}\nBoard at {ship_url}",
  trackedLinks: [],
  openingDmEnabled: false,
  requireFollow: false,
  dmTriggerEnabled: false,
  followUpEnabled: false,
  publicReplyMessage: "Check your DMs!",
  publicReplyMessages: [],
};

describe("automation rules", () => {
  it("accepts a plain-text automation with {boarding_code}", () => {
    expect(shipAutomationProblem(goodAutomation)).toBeNull();
  });

  it.each([
    [{ trackedLinks: [{}] }, /tracked links/],
    [{ openingDmEnabled: true }, /opening DM/],
    [{ requireFollow: true }, /require-follow/],
    [{ dmTriggerEnabled: true }, /DM keyword trigger/],
    [{ followUpEnabled: true }, /follow-up/],
    [{ dmMessage: "Welcome aboard!" }, /\{boarding_code\}/],
    [{ publicReplyMessages: ["Your code is {boarding_code}"] }, /public reply/],
  ])("refuses %o", (patch, reason) => {
    expect(shipAutomationProblem({ ...goodAutomation, ...patch })).toMatch(reason);
  });

  it("refuses before calling the ship when misconfigured or unconfigured", async () => {
    const fetchImpl = vi.fn();
    const bad = await prepareShipBoarding({ ...goodAutomation, trackedLinks: [{}] }, input, fetchImpl as unknown as typeof fetch);
    expect(bad).toMatchObject({ action: "skip", status: "FAILED" });
    const unconfigured = await prepareShipBoarding(goodAutomation, input, fetchImpl as unknown as typeof fetch);
    expect(unconfigured).toMatchObject({ action: "skip", status: "FAILED", reason: expect.stringMatching(/not configured/) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["already_boarded", "SKIPPED_DEDUP"],
    ["paused", "SKIPPED_DEDUP"],
    ["comment_used", "SKIPPED_DEDUP"],
  ])("skips when the ship says %s", async (status, dmStatus) => {
    vi.stubEnv("SHIP_API_URL", "https://ship.test");
    vi.stubEnv("SHIP_INTERNAL_SECRET", secret.toString("base64"));
    const step = await prepareShipBoarding(goodAutomation, input, (async () => jsonResponse({ status })) as typeof fetch);
    expect(step).toMatchObject({ action: "skip", status: dmStatus });
  });
});

describe("message rendering", () => {
  it("fills placeholders case-insensitively and treats $ literally", () => {
    const b = { invitationId: "x", code: CODE, shipUrl: "https://ship.test/board?x=$&" };
    expect(applyShipPlaceholders("{BOARDING_CODE} at {ship_url}", b)).toBe(`${CODE} at https://ship.test/board?x=$&`);
    expect(applyShipPlaceholders("{boarding_code}", null)).toBe("{boarding_code}");
  });

  it("reduces errors to short codes with no message text", () => {
    const meta = Object.assign(new Error(`failed for ${CODE}`), { name: "MetaApiError", code: 10 });
    expect(errorCodeOf(meta)).toBe("MetaApiError:10");
    expect(errorCodeOf(new TypeError(`boom ${CODE}`))).toBe("TypeError");
    expect(errorCodeOf("nope")).toBeUndefined();
  });
});

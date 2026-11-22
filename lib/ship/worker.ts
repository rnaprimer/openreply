/**
 * Glue between OpenReply's DM worker and The Internet Ship. dm-worker.ts
 * calls these at four points (see lib/ship/README.md); everything else about
 * boarding codes stays here so the upstream worker stays easy to merge.
 *
 * Rules enforced here:
 *  - A boarding code is fetched BEFORE the DM is claimed, so a ship outage
 *    leaves the comment retryable instead of "unconfirmed".
 *  - Ship automations must take the plain-text private-reply path: no tracked
 *    links, opening DM, follow gate, DM keyword trigger or follow-up, and the
 *    DM template must contain {boarding_code}. Anything else is refused.
 *  - The code exists only in memory. Nothing here logs or stores it, and
 *    errors never include message text.
 */
import { issueBoardingCode, reportDelivery, type IssueInput } from "./adapter";
import { shipAutomationIds, shipConfig } from "./config";
import { ShipApiError } from "./client";
import type { DeliveryOutcome } from "./contract";

export { isShipAutomation } from "./config";

export const BOARDING_CODE_PLACEHOLDER = /\{boarding_code\}/gi;
export const SHIP_URL_PLACEHOLDER = /\{ship_url\}/gi;

/** The fields of an Automation (with its tracked links) that matter here. */
export type ShipAutomationShape = {
  id: string;
  dmMessage: string;
  trackedLinks: unknown[];
  openingDmEnabled: boolean;
  requireFollow?: boolean | null;
  dmTriggerEnabled?: boolean | null;
  followUpEnabled?: boolean | null;
  publicReplyMessage?: string | null;
  publicReplyMessages?: string[] | null;
};

export type ShipBoarding = { invitationId: string; code: string; shipUrl: string };

export type ShipStep =
  | { action: "send"; boarding: ShipBoarding }
  | { action: "skip"; status: "SKIPPED_DEDUP" | "FAILED"; reason: string };

/** Why this automation can't send boarding codes, or null if it can. */
export function shipAutomationProblem(automation: ShipAutomationShape): string | null {
  const problems: string[] = [];
  if (automation.trackedLinks.length > 0) problems.push("remove tracked links");
  if (automation.openingDmEnabled) problems.push("turn off the opening DM");
  if (automation.requireFollow) problems.push("turn off require-follow");
  if (automation.dmTriggerEnabled) problems.push("turn off the DM keyword trigger");
  if (automation.followUpEnabled) problems.push("turn off the follow-up message");
  if (!new RegExp(BOARDING_CODE_PLACEHOLDER.source, "i").test(automation.dmMessage))
    problems.push("add {boarding_code} to the DM message");
  const publicReplies = [automation.publicReplyMessage ?? "", ...(automation.publicReplyMessages ?? [])];
  if (publicReplies.some((m) => /\{boarding_code\}/i.test(m)))
    problems.push("never put {boarding_code} in a public reply");
  return problems.length ? `Ship automation misconfigured: ${problems.join("; ")}` : null;
}

/**
 * Called before claimCommentDelivery for ship automations. Returns the code
 * to send, or a reason to skip (the caller releases its reservations).
 * Throws ShipApiError when the ship is unreachable or erroring, so the job
 * is retried with the worker's normal backoff.
 */
export async function prepareShipBoarding(
  automation: ShipAutomationShape,
  input: IssueInput,
  fetchImpl?: typeof fetch,
): Promise<ShipStep> {
  const problem = shipAutomationProblem(automation);
  if (problem) return { action: "skip", status: "FAILED", reason: problem };
  const cfg = shipConfig();
  if (!cfg.ok) return { action: "skip", status: "FAILED", reason: `Ship integration not configured: ${cfg.reason}` };

  const result = await issueBoardingCode(cfg.config, input, fetchImpl);
  switch (result.status) {
    case "issued":
    case "existing":
    case "active_elsewhere":
      return {
        action: "send",
        boarding: { invitationId: result.invitation_id, code: result.boarding_code, shipUrl: result.ship_url },
      };
    case "already_boarded":
      return { action: "skip", status: "SKIPPED_DEDUP", reason: "Already aboard the ship: no new boarding code" };
    case "comment_used":
      return { action: "skip", status: "SKIPPED_DEDUP", reason: "This comment's boarding code was already used or expired" };
    case "paused":
      return { action: "skip", status: "SKIPPED_DEDUP", reason: "Ship boarding is paused" };
  }
}

/** Fills {boarding_code} and {ship_url} in an already-rendered message. No-op without a boarding. */
export function applyShipPlaceholders(message: string, boarding: ShipBoarding | null): string {
  if (!boarding) return message;
  // Function replacers: "$" in a value must never be read as a replacement pattern.
  return message.replace(BOARDING_CODE_PLACEHOLDER, () => boarding.code).replace(SHIP_URL_PLACEHOLDER, () => boarding.shipUrl);
}

/** A short, text-free code for an error (e.g. "MetaApiError:10"), safe to send to the ship. */
export function errorCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  const name = error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "Error";
  return typeof code === "number" || typeof code === "string"
    ? `${name}:${String(code).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 20)}`
    : name;
}

/** Best-effort delivery report: never throws, never delays the worker's own bookkeeping. */
export async function reportShipDelivery(
  boarding: ShipBoarding | null,
  commentId: string,
  outcome: DeliveryOutcome,
  error?: unknown,
  fetchImpl?: typeof fetch,
): Promise<void> {
  if (!boarding) return;
  const cfg = shipConfig();
  if (!cfg.ok) return;
  try {
    await reportDelivery(cfg.config, boarding.invitationId, commentId, outcome, errorCodeOf(error), fetchImpl);
  } catch (reportError) {
    console.error("[Ship] Failed to report delivery:", reportError instanceof ShipApiError ? reportError.message : "unknown error");
  }
}

/** Logs (ids and reasons only) any configured ship automation that can't work. Called once at worker start. */
export async function checkShipAutomations(
  findAutomations: (ids: string[]) => Promise<ShipAutomationShape[]>,
): Promise<void> {
  const ids = [...shipAutomationIds()];
  if (ids.length === 0) return;
  const cfg = shipConfig();
  if (!cfg.ok) console.error(`[Ship] Boarding automations are set but the integration is not: ${cfg.reason}`);
  try {
    const found = await findAutomations(ids);
    for (const id of ids) {
      const automation = found.find((a) => a.id === id);
      if (!automation) {
        console.error(`[Ship] Boarding automation ${id} not found`);
        continue;
      }
      const problem = shipAutomationProblem(automation);
      if (problem) console.error(`[Ship] Boarding automation ${id} will be refused: ${problem}`);
    }
  } catch {
    console.error("[Ship] Could not check boarding automations at startup");
  }
}


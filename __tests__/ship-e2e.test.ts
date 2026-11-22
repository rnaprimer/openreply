/**
 * End to end, Milestone 3 "done when": a simulated Instagram comment
 * produces a DM containing a boarding code.
 *
 * A real Meta-format webhook payload goes through OpenReply's own webhook
 * parsing (processInstagramWebhook) and DM worker (processComment). The worker
 * calls a REAL running ship over signed HTTP; the code it DMs is then redeemed
 * on that ship. Only Meta's send API, OpenReply's Postgres and Redis are
 * stand-ins (the mock harness below is copied from dm-worker.test.ts).
 *
 * Runs only when SHIP_E2E_URL and SHIP_INTERNAL_SECRET are set, e.g.:
 *   SHIP_E2E_URL=http://localhost:3200 SHIP_INTERNAL_SECRET=... npx vitest run __tests__/ship-e2e.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPrisma,
  mockSendPrivateReply,
  mockSendPrivateReplyWithLinkButton,
  mockSendPrivateReplyWithButton,
  mockGetUserFollowStatus,
  mockSendDirectMessageWithButton,
  mockSendDirectMessage,
  mockSendDirectMessageWithLinkButton,
  mockDecryptToken,
  mockMatchKeywords,
  mockReserveDMSlot,
  mockReleaseDMSlot,
  mockPauseDMSends,
  mockRecordThreadRefusal,
  mockRecordDelivery,
  mockReleaseHeldSlot,
  mockQueueAdd,
  mockReserveWorkspaceDMSend,
  mockReleaseWorkspaceDMReservation,
} = vi.hoisted(() => ({
  mockPrisma: {
    zernioConnection: { findUnique: vi.fn() },
    postbackDelivery: { create: vi.fn(), delete: vi.fn() },
    automation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    dmLog: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    instagramAccount: {
      findUnique: vi.fn(),
    },
    operationalEvent: {
      create: vi.fn(),
    },
  },
  mockSendPrivateReply: vi.fn(),
  mockSendPrivateReplyWithLinkButton: vi.fn(),
  mockSendPrivateReplyWithButton: vi.fn(),
  mockGetUserFollowStatus: vi.fn(),
  mockSendDirectMessageWithButton: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockSendDirectMessageWithLinkButton: vi.fn(),
  mockDecryptToken: vi.fn(),
  mockMatchKeywords: vi.fn(),
  mockReserveDMSlot: vi.fn(),
  mockReleaseDMSlot: vi.fn(),
  mockPauseDMSends: vi.fn(),
  mockRecordThreadRefusal: vi.fn(),
  mockRecordDelivery: vi.fn(),
  mockReleaseHeldSlot: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockReserveWorkspaceDMSend: vi.fn(),
  mockReleaseWorkspaceDMReservation: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/meta/client", () => ({
  sendPrivateReply: mockSendPrivateReply,
  sendPrivateReplyWithLinkButton: mockSendPrivateReplyWithLinkButton,
  sendPrivateReplyWithButton: mockSendPrivateReplyWithButton,
  getUserFollowStatus: mockGetUserFollowStatus,
  sendDirectMessageWithButton: mockSendDirectMessageWithButton,
  sendDirectMessage: mockSendDirectMessage,
  sendDirectMessageWithLinkButton: mockSendDirectMessageWithLinkButton,
  sendCommentReply: vi.fn(),
  MetaApiError: class MetaApiError extends Error {
    code: number;
    constructor(
      code: number,
      _subcode: number | undefined,
      _fbTraceId: string | undefined,
      message: string
    ) {
      super(message);
      this.code = code;
      this.name = "MetaApiError";
    }
  },
  TokenExpiredError: class TokenExpiredError extends Error {
    name = "TokenExpiredError";
  },
  RateLimitError: class RateLimitError extends Error {
    name = "RateLimitError";
  },
}));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: mockDecryptToken,
}));

vi.mock("@/lib/utils/keyword-matcher", () => ({
  matchKeywords: mockMatchKeywords,
}));

vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: mockReserveDMSlot,
  releaseDMSlot: mockReleaseDMSlot,
  pauseDMSends: mockPauseDMSends,
  recordThreadRefusal: mockRecordThreadRefusal,
  recordDelivery: mockRecordDelivery,
  releaseHeldSlot: mockReleaseHeldSlot,
  ACCOUNT_BLOCK_PAUSE_MS: 1_800_000,
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mockReleaseWorkspaceDMReservation,
}));

vi.mock("@/lib/ops/worker-health", () => ({
  recordWorkerAlert: vi.fn(),
}));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({
    add: mockQueueAdd,
  }),
  getRedisConnection: vi.fn(),
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
  MESSAGE_JOB_NAME: "process-message",
}));

vi.mock("bullmq", () => {
  function MockWorker(_name: string, processor: unknown) {
    (global as Record<string, unknown>).__dmWorkerProcessor = processor;
    return {
      on: vi.fn(),
      close: vi.fn(),
    };
  }
  return {
    Worker: MockWorker,
    UnrecoverableError: class UnrecoverableError extends Error {
      name = "UnrecoverableError";
    },
  };
});

import { createDMWorker } from "../lib/queue/dm-worker";

const usagePeriodStart = new Date("2026-05-01T00:00:00.000Z");

const mockAutomation = {
  id: "auto_789",
  workspaceId: "workspace_123",
  instagramAccountId: "ig_account_row_1",
  postId: "media_101",
  keywords: ["LINK", "PRICE"],
  dmMessage: "Hey {username}! Here is the link: https://example.com",
  isActive: true,
  wholeWordMatch: true,
  matchAnyPost: false,
  matchAnyWord: false,
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  linkButtonLabel: null,
  publicReplyEnabled: false,
  publicReplyMessage: null,
  publicReplyMessages: [],
  instagramAccount: {
    id: "ig_account_row_1",
    instagramId: "ig_456",
    accessToken: "encrypted_token_abc",
  },
  workspace: {
    id: "workspace_123",
  },
  trackedLinks: [],
};

const mockJobData = {
  instagramAccountId: "ig_456",
  commentId: "comment_555",
  commentText: "I want the LINK!",
  commenterId: "commenter_999",
  commenterName: "commenter_user",
  mediaId: "media_101",
};

function getProcessor(): (job: {
  name?: string;
  data: typeof mockJobData | Record<string, unknown>;
  id: string;
  attemptsMade: number;
}) => Promise<void> {
  createDMWorker();
  return (global as Record<string, unknown>).__dmWorkerProcessor as (job: {
    name?: string;
    data: typeof mockJobData | Record<string, unknown>;
    id: string;
    attemptsMade: number;
  }) => Promise<void>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.postbackDelivery.create.mockReset().mockResolvedValue({});
  mockPrisma.postbackDelivery.delete.mockReset().mockResolvedValue({});

  mockPrisma.automation.findMany.mockResolvedValue([mockAutomation]);
  mockPrisma.automation.findFirst.mockResolvedValue(null);
  mockPrisma.dmLog.findUnique.mockResolvedValue(null);
  mockPrisma.dmLog.create.mockResolvedValue({});
  // Two different lookups share findFirst: the cross-campaign private-reply
  // check (keyed on status SENT) and the postback's name lookup. Only the
  // latter should resolve by default, or every comment would look like a
  // duplicate of an already-answered one.
  mockPrisma.dmLog.findFirst.mockImplementation(
    async (args: { where?: { status?: string } } = {}) =>
      args.where?.status === "SENT" ? null : { commenterName: "commenter_user" }
  );
  mockPrisma.dmLog.upsert.mockResolvedValue({});
  mockPrisma.dmLog.update.mockReset().mockResolvedValue({});
  mockPrisma.dmLog.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.instagramAccount.findUnique.mockResolvedValue({
    workspaceId: "workspace_123",
  });
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockDecryptToken.mockReturnValue("decrypted_token");
  mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
  mockReserveWorkspaceDMSend.mockResolvedValue({
    allowed: true,
    reserved: true,
    remaining: 100,
    limit: 2000,
    periodStart: usagePeriodStart,
  });
  mockReserveDMSlot.mockResolvedValue({
    allowed: true,
    currentCount: 11,
    remainingDMs: 179,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  });
  mockReleaseDMSlot.mockResolvedValue(0);
  mockPauseDMSends.mockResolvedValue(undefined);
  mockRecordThreadRefusal.mockResolvedValue(false);
  mockRecordDelivery.mockResolvedValue(undefined);
  mockReleaseHeldSlot.mockResolvedValue(undefined);
  mockReleaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mockSendPrivateReply.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_001",
  });
  mockSendPrivateReplyWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_002",
  });
  mockSendPrivateReplyWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_003",
  });
  mockSendDirectMessageWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_004",
  });
  mockSendDirectMessage.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_005",
  });
  mockSendDirectMessageWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_006",
  });
  mockGetUserFollowStatus.mockResolvedValue(true);
});



import { processInstagramWebhook } from "@/lib/queue/process-webhook";

const SHIP_URL = process.env.SHIP_E2E_URL;
const run = Boolean(SHIP_URL && process.env.SHIP_INTERNAL_SECRET);

const shipAutomation = {
  ...mockAutomation,
  id: "auto_ship_e2e",
  matchAnyWord: true,
  postId: "reel_1",
  dmMessage: "🚢 YOUR BOARDING PASS IS READY!\n\nYour unique boarding code:\n\n{boarding_code}\n\nVisit: {ship_url}\n\nThis code can only be redeemed once.",
  requireFollow: false,
  dmTriggerEnabled: false,
  followUpEnabled: false,
};

const runId = Date.now().toString(36);
const ACCOUNT = "17841400000099999";

/** A comment webhook exactly as Meta sends it. */
function commentWebhook(commentId: string, commenterId: string, text = "🚢") {
  return {
    object: "instagram",
    entry: [
      {
        id: ACCOUNT,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: "comments",
            value: { id: commentId, text, from: { id: commenterId, username: "someone" }, media: { id: "reel_1", media_product_type: "REELS" } },
          },
        ],
      },
    ],
  };
}

/** Runs a webhook through OpenReply: parse → queue → worker. Returns the DM texts sent to Instagram. */
async function deliverWebhook(payload: unknown): Promise<string[]> {
  mockQueueAdd.mockClear();
  mockSendPrivateReply.mockClear();
  await processInstagramWebhook({ payload: payload as never, provider: "META" as never });
  const processor = getProcessor();
  for (const [name, data, opts] of mockQueueAdd.mock.calls) {
    await processor({ name, data, id: opts?.jobId ?? "job", attemptsMade: 0 });
  }
  return mockSendPrivateReply.mock.calls.map((c) => c[3] as string);
}

async function redeemOnShip(code: string, username: string) {
  return fetch(`${SHIP_URL}/api/boarding/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SHIP_URL!, "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200)}` },
    body: JSON.stringify({ code, username, characterVariant: 3 }),
  });
}

describe.skipIf(!run)("E2E: Instagram comment → OpenReply → ship → DM with code → redeemed", () => {
  beforeEach(() => {
    vi.stubEnv("SHIP_API_URL", SHIP_URL!);
    vi.stubEnv("SHIP_BOARDING_AUTOMATION_IDS", shipAutomation.id);
    const accounts = { findMany: vi.fn().mockResolvedValue([{ id: "ig_account_row_1", instagramId: ACCOUNT, workspaceId: "workspace_123" }]) };
    Object.assign(mockPrisma.instagramAccount, accounts);
    Object.assign(mockPrisma, {
      webhookEvent: { create: vi.fn().mockResolvedValue({ id: "wh_1" }), update: vi.fn().mockResolvedValue({}) },
    });
    Object.assign(mockPrisma.dmLog, { findMany: vi.fn().mockResolvedValue([]) });
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...shipAutomation, instagramAccount: { ...shipAutomation.instagramAccount, instagramId: ACCOUNT } },
    ]);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("DMs a real code for a comment, the code boards exactly once, and the commenter gets no second code", async () => {
    const commenter = `e2e_user_${runId}`;

    // 1. Someone comments on the Reel.
    const [dm] = await deliverWebhook(commentWebhook(`e2e_c1_${runId}`, commenter));
    expect(dm).toBeDefined();
    const code = dm.match(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/)?.[0];
    expect(code, "DM contains a boarding code").toBeDefined();
    expect(dm).toContain(`Visit: ${SHIP_URL}/board`);
    expect(dm).not.toMatch(/\{boarding_code\}|\{ship_url\}/);
    console.info(`[e2e] DM sent to Instagram:\n${dm.replace(code!, "XXXX-XXXX-XXXX-XXXX")}`);

    // 2. The same webhook delivered again (Meta retries): the ship returns the same code.
    const [again] = await deliverWebhook(commentWebhook(`e2e_c1_${runId}`, commenter));
    expect(again).toContain(code);

    // 3. The code redeems on the ship once.
    const first = await redeemOnShip(code!, `e2e_${runId}`.slice(0, 20));
    expect(first.status).toBe(201);
    expect((await redeemOnShip(code!, `e2e2_${runId}`.slice(0, 20))).status).toBe(409);

    // 4. The same person comments again: already boarded, so no DM at all.
    const later = await deliverWebhook(commentWebhook(`e2e_c2_${runId}`, commenter));
    expect(later).toEqual([]);
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SKIPPED_DEDUP" }) })
    );
  }, 30_000);

  it("ignores the account's own comments", async () => {
    const dms = await deliverWebhook(commentWebhook(`e2e_self_${runId}`, ACCOUNT));
    expect(dms).toEqual([]);
  });
});

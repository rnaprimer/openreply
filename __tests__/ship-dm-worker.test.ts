/**
 * processComment with The Internet Ship (PLAN §D tests): the boarding code is
 * fetched before the claim, ship outages stay retryable, already-boarded
 * commenters get nothing, unconfirmed sends are never repeated, and the code
 * never reaches logs or the database.
 *
 * The mock harness below is copied from dm-worker.test.ts.
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

import { MetaApiError } from "@/lib/meta/client";
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

function createMockJob(data: Record<string, unknown> = mockJobData) {
  return {
    data,
    id: "job_001",
    attemptsMade: 0,
  };
}

function createMockPostbackJob(
  data: Record<string, unknown> = {
    instagramAccountId: "ig_456",
    userId: "commenter_999",
    payload: "reveal:auto_789",
  }
) {
  return {
    name: "process-postback",
    data,
    id: "postback_job_001",
    attemptsMade: 0,
  };
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


const SHIP_SECRET = Buffer.alloc(32, 5);
const CODE = "K7PM-4XQ2-B9RT-6NWA";
const INVITE_ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";

const shipAutomation = {
  ...mockAutomation,
  id: "auto_ship",
  matchAnyWord: true,
  dmMessage: "🚢 Your boarding pass: {boarding_code}\nBoard at {ship_url}",
  requireFollow: false,
  dmTriggerEnabled: false,
  followUpEnabled: false,
};

type ShipCall = { path: string; body: Record<string, unknown> };
let shipCalls: ShipCall[];
let issueReply: () => Promise<Response>;

function shipJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const issuedReply = () =>
  shipJson({
    status: "issued",
    invitation_id: INVITE_ID,
    boarding_code: CODE,
    expires_at: "2026-12-01T00:00:00.000Z",
    ship_url: "https://ship.test/board",
  });

/** Everything the worker wrote to the database or the console, as one string. */
function everythingRecorded(): string {
  const calls = [
    mockPrisma.dmLog.update.mock.calls,
    mockPrisma.dmLog.updateMany.mock.calls,
    mockPrisma.dmLog.upsert.mock.calls,
    mockPrisma.dmLog.create.mock.calls,
    mockPrisma.operationalEvent.create.mock.calls,
    (console.log as unknown as { mock: { calls: unknown[] } }).mock.calls,
    (console.error as unknown as { mock: { calls: unknown[] } }).mock.calls,
    (console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls,
  ];
  return JSON.stringify(calls, (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v));
}

/** The DM claim is the dmLog.updateMany that sets dmDeliveryUnconfirmed: true. */
function dmClaimCalls() {
  return mockPrisma.dmLog.updateMany.mock.calls.filter(
    (call: unknown[]) => (call[0] as { data?: { dmDeliveryUnconfirmed?: boolean } } | undefined)?.data?.dmDeliveryUnconfirmed === true
  );
}

beforeEach(() => {
  vi.stubEnv("SHIP_API_URL", "https://ship.test");
  vi.stubEnv("SHIP_INTERNAL_SECRET", SHIP_SECRET.toString("base64"));
  vi.stubEnv("SHIP_BOARDING_AUTOMATION_IDS", "auto_ship");
  mockPrisma.automation.findMany.mockResolvedValue([shipAutomation]);
  shipCalls = [];
  issueReply = async () => issuedReply();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(init.body as string);
      // Every call must be signed correctly.
      const headers = init.headers as Record<string, string>;
      const { createHmac } = await import("node:crypto");
      const expected = createHmac("sha256", SHIP_SECRET)
        .update(`${headers["x-ship-timestamp"]}.${init.body}`)
        .digest("hex");
      if (headers["x-ship-signature"] !== expected) return shipJson({ error: "UNAUTHORIZED" }, 401);
      shipCalls.push({ path, body });
      if (path === "/internal/invites/issue") return issueReply();
      if (path === "/internal/invites/delivery-status") return shipJson({ ok: true });
      return shipJson({ error: "NOT_FOUND" }, 404);
    })
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Ship boarding — happy path", () => {
  it("issues the code before the claim, DMs it, and reports delivery", async () => {
    const processor = getProcessor();
    await processor(createMockJob());

    expect(shipCalls[0]).toEqual({
      path: "/internal/invites/issue",
      body: {
        event_id: "job_001",
        instagram_account_id: "ig_456",
        instagram_user_id: "commenter_999",
        instagram_comment_id: "comment_555",
        instagram_media_id: "media_101",
      },
    });
    // The issue call happened before the claim.
    const issueOrder = (fetch as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
    const claimOrder = mockPrisma.dmLog.updateMany.mock.invocationCallOrder[0];
    expect(issueOrder).toBeLessThan(claimOrder);

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    const sent = mockSendPrivateReply.mock.calls[0][3] as string;
    expect(sent).toBe(`🚢 Your boarding pass: ${CODE}\nBoard at https://ship.test/board`);

    expect(shipCalls[1]).toEqual({
      path: "/internal/invites/delivery-status",
      body: { invitation_id: INVITE_ID, instagram_comment_id: "comment_555", outcome: "delivered" },
    });
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SENT" }) })
    );
  });

  it("never writes the code or the rendered message to the database or logs", async () => {
    const processor = getProcessor();
    await processor(createMockJob());
    // A failing send as well, which writes errorMessage and logs.
    mockSendPrivateReply.mockRejectedValueOnce(new MetaApiError(10, undefined, undefined, "Outside of allowed window"));
    await processor(createMockJob({ ...mockJobData, commentId: "comment_556" })).catch(() => {});
    const recorded = everythingRecorded();
    expect(recorded).not.toContain(CODE);
    expect(recorded).not.toContain("K7PM");
    expect(recorded).not.toContain("Your boarding pass");
  });
});

describe("Ship boarding — ship unavailable before the claim", () => {
  it.each([
    ["network error", async () => { throw new TypeError("fetch failed"); }],
    ["5xx", async () => shipJson({ error: "x" }, 503)],
  ])("on %s: throws for BullMQ retry, releases reservations, never claims or sends", async (_label, reply) => {
    issueReply = reply as () => Promise<Response>;
    const processor = getProcessor();
    await expect(processor(createMockJob())).rejects.toThrow(/Ship API/);
    expect(dmClaimCalls()).toHaveLength(0);
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReleaseDMSlot).toHaveBeenCalledWith("ig_456");
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith("workspace_123", usagePeriodStart);
    // The log is still PENDING and unclaimed, so a retry runs the comment again.
    expect(mockPrisma.dmLog.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );
  });

  it("succeeds on the retry once the ship is back, with the same comment id", async () => {
    issueReply = async () => shipJson({ error: "x" }, 503);
    const processor = getProcessor();
    await expect(processor(createMockJob())).rejects.toThrow();
    issueReply = async () => issuedReply();
    await processor(createMockJob());
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    // Both attempts asked for the same comment, so the ship returns one invite (idempotent on the comment id).
    const issues = shipCalls.filter((c) => c.path === "/internal/invites/issue");
    expect(issues).toHaveLength(2);
    expect(issues[0].body).toEqual(issues[1].body);
  });
});

describe("Ship boarding — nothing to send", () => {
  it.each([["already_boarded"], ["paused"], ["comment_used"]])(
    "%s: records SKIPPED_DEDUP with a reason, releases reservations, sends nothing",
    async (status) => {
      issueReply = async () => shipJson({ status });
      const processor = getProcessor();
      await processor(createMockJob());
      expect(mockSendPrivateReply).not.toHaveBeenCalled();
      expect(dmClaimCalls()).toHaveLength(0);
      expect(mockReleaseDMSlot).toHaveBeenCalled();
      expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalled();
      expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "SKIPPED_DEDUP", errorMessage: expect.any(String) }),
        })
      );
    }
  );

  it("refuses a misconfigured automation without calling the ship or sending", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...shipAutomation, trackedLinks: [{ slug: "s", label: null, destinationUrl: "https://x.test" }] },
    ]);
    const processor = getProcessor();
    await processor(createMockJob());
    expect(shipCalls).toHaveLength(0);
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", errorMessage: expect.stringMatching(/tracked links/) }),
      })
    );
  });

  it("leaves non-ship automations untouched", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([mockAutomation]);
    const processor = getProcessor();
    await processor(createMockJob());
    expect(shipCalls).toHaveLength(0);
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });
});

describe("Ship boarding — delivery outcomes", () => {
  it("an unconfirmed send is never retried, and the ship is told it is unconfirmed", async () => {
    mockSendPrivateReply.mockRejectedValueOnce(new TypeError("socket hang up"));
    const processor = getProcessor();
    await expect(processor(createMockJob())).rejects.toThrow();
    expect(shipCalls.at(-1)).toEqual({
      path: "/internal/invites/delivery-status",
      body: { invitation_id: INVITE_ID, instagram_comment_id: "comment_555", outcome: "unconfirmed", error_code: "DeliveryUnconfirmedError" },
    });

    // Worker restart / retry: the log now says delivery is unconfirmed.
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      status: "FAILED",
      attempts: 1,
      dmDeliveryUnconfirmed: true,
      publicReplySentAt: null,
      errorMessage: "Message delivery is unconfirmed",
    });
    mockSendPrivateReply.mockClear();
    const callsBefore = shipCalls.length;
    await processor(createMockJob());
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(shipCalls.length).toBe(callsBefore); // not even a new code request
  });

  it("a confirmed rejection reports failed with a short error code", async () => {
    mockSendPrivateReply.mockRejectedValueOnce(new MetaApiError(10, undefined, undefined, "Outside of allowed window"));
    const processor = getProcessor();
    await expect(processor(createMockJob())).rejects.toThrow();
    expect(shipCalls.at(-1)!.body).toMatchObject({ outcome: "failed", error_code: "MetaApiError:10" });
  });

  it("a failing delivery report never breaks the worker's own bookkeeping", async () => {
    const realFetch = fetch as unknown as (u: string, i: RequestInit) => Promise<Response>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) =>
        url.endsWith("/delivery-status") ? Promise.reject(new TypeError("down")) : realFetch(url, init)
      )
    );
    const processor = getProcessor();
    await processor(createMockJob());
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SENT" }) })
    );
  });
});

describe("Ship boarding — other entry points never send codes", () => {
  it("an inbound DM keyword never triggers a ship automation", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([{ ...shipAutomation, dmTriggerEnabled: true }]);
    const processor = getProcessor();
    await processor({
      name: "process-message",
      data: { instagramAccountId: "ig_456", messageId: "m1", messageText: "hi", senderId: "commenter_999" },
      id: "msg_job",
      attemptsMade: 0,
    });
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
    expect(shipCalls).toHaveLength(0);
  });

  it("a postback for a ship automation is ignored", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({ ...shipAutomation, workspace: { id: "workspace_123" } });
    const processor = getProcessor();
    await processor(createMockPostbackJob({ instagramAccountId: "ig_456", userId: "commenter_999", payload: "reveal:auto_ship" }));
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
  });
});

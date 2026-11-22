import {
  DeliveryStatusResponse,
  INTERNAL_PATHS,
  IssueResponse,
  type DeliveryOutcome,
} from "./contract";
import { signedPost } from "./client";
import type { ShipConfig } from "./config";

export type IssueInput = {
  instagramAccountId: string;
  commenterId: string;
  commentId: string;
  mediaId: string;
  eventId?: string;
};

/** Asks the ship for this comment's boarding code. Idempotent on the comment id. */
export function issueBoardingCode(config: ShipConfig, input: IssueInput, fetchImpl?: typeof fetch): Promise<IssueResponse> {
  return signedPost(
    config,
    INTERNAL_PATHS.issue,
    {
      ...(input.eventId ? { event_id: input.eventId } : {}),
      instagram_account_id: input.instagramAccountId,
      instagram_user_id: input.commenterId,
      instagram_comment_id: input.commentId,
      instagram_media_id: input.mediaId,
    },
    IssueResponse,
    fetchImpl,
  );
}

/** Tells the ship how the DM went. Callers treat it as best-effort. */
export async function reportDelivery(
  config: ShipConfig,
  invitationId: string,
  commentId: string,
  outcome: DeliveryOutcome,
  errorCode?: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  await signedPost(
    config,
    INTERNAL_PATHS.deliveryStatus,
    {
      invitation_id: invitationId,
      instagram_comment_id: commentId,
      outcome,
      ...(errorCode ? { error_code: errorCode } : {}),
    },
    DeliveryStatusResponse,
    fetchImpl,
  );
}

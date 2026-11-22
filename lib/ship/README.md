# The Internet Ship integration

This fork adds one thing to OpenReply: comment campaigns that DM each
commenter a unique, single-use boarding code for The Internet Ship. Upstream
OpenReply is otherwise unchanged, so it stays easy to merge.

## Where the code lives

| File | What it does |
| --- | --- |
| `lib/ship/contract.ts` | Zod schemas for the internal API. It's identical to the ship's `src/lib/internal/contract.ts`, so change both together. |
| `lib/ship/config.ts` | Reads the env vars below. |
| `lib/ship/client.ts` | Makes HMAC-signed `fetch` calls with a 5 s timeout. Its errors never contain request or response bodies. |
| `lib/ship/adapter.ts` | `issueBoardingCode()` and `reportDelivery()`. |
| `lib/ship/worker.ts` | The hooks the worker calls, plus the rules for which automations are allowed. |

The edits to `lib/queue/dm-worker.ts` are all marked `[ship]`:

1. In `processComment`, after the DM slot is reserved and **before**
   `claimCommentDelivery`, the worker calls `prepareShipBoarding`. If the ship
   is unreachable, the worker releases the slot and workspace reservation and
   throws, so BullMQ retries later. If the commenter already boarded, boarding
   is paused, or the comment's code is spent, the worker records
   `SKIPPED_DEDUP` with a reason and moves on.
2. In the plain-text branch, `applyShipPlaceholders` fills `{boarding_code}`
   and `{ship_url}`, in memory only.
3. After a send it calls `reportShipDelivery`: `delivered` on success, and
   `failed` or `unconfirmed` on error. The report is best-effort.
4. `processMessage`, `processPostback` and `processFollowUp` skip ship
   automations, so a code can only go out through `processComment`.
5. `createDMWorker` logs any ship automation that will be refused. It logs
   ids and reasons only.

The worker never logs or stores the code or the rendered message. DmLog keeps
OpenReply's usual fields, and error messages come from Meta errors or
`ShipApiError`. Neither contains message text.

## Environment variables (worker and web app)

```
SHIP_API_URL=https://ship.example.com      # https required (localhost allowed for dev)
SHIP_INTERNAL_SECRET=<base64, >= 32 bytes> # same value as the ship's SHIP_INTERNAL_SECRET
SHIP_BOARDING_AUTOMATION_IDS=<id>[,<id>]   # Automation ids that send boarding codes
```

## Setting up the campaign

Create a normal automation in the dashboard:

- **Trigger:** "Any word" on, and the Reel as the post.
- **DM message:** must contain `{boarding_code}`, and can contain `{ship_url}`.
  For example:
  ```
  🚢 YOUR BOARDING PASS IS READY!

  Your unique boarding code:

  {boarding_code}

  Visit: {ship_url}

  This code can only be redeemed once.
  ```
- **Leave off:** tracked links, opening DM, require follow, DM keyword trigger
  and follow-up. The worker refuses ship automations that use any of them, and
  never puts `{boarding_code}` in a public reply.

Then add the automation's id to `SHIP_BOARDING_AUTOMATION_IDS` and restart the
worker.

## Tests

- `__tests__/ship-adapter.test.ts`: signing, timeouts, every issue outcome,
  and the automation rules.
- `__tests__/ship-dm-worker.test.ts`: the code is fetched before the claim; a
  ship outage stays retryable; already-boarded commenters are skipped; an
  unconfirmed send is never retried; and the code never reaches logs or the
  database.
- `__tests__/ship-e2e.test.ts`: a real webhook payload through OpenReply,
  calling a running ship over signed HTTP, then redeeming the code. To run it:
  ```
  SHIP_E2E_URL=http://localhost:3200 SHIP_INTERNAL_SECRET=... npx vitest run __tests__/ship-e2e.test.ts
  ```

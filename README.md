# Chai Society - WhatsApp Lead Qualification Bot

This is a self-contained Node.js app that runs the Chai Society events &
corporate gifting lead qualification conversation directly on the
official WhatsApp Cloud API. It does not use AiSensy, WhatChimp, Typebot,
or any other third-party BSP/platform; it talks to Meta's API directly.

This replaces the Typebot flow JSON we built earlier. The conversation
content (questions, reactions, recommendations, the intent checkpoint,
the warm handoff) is the same as what was tested and approved in
Typebot, just running as plain code instead of a drag-and-drop flow.

## What's in this folder

- `src/flow.js` - the conversation logic itself. All the actual wording
  lives here. If you want to change what the bot says, this is the file
  to edit.
- `src/store.js` - tracks which step each phone number is currently on.
  Currently in-memory (resets on redeploy); can be swapped for a real
  database later without touching the other files.
- `src/whatsapp.js` - talks to Meta's WhatsApp Cloud API (sends
  messages, parses incoming ones).
- `src/notifyAreeva.js` - fires when a lead confirms genuine intent.
  Currently logs the lead and optionally sends Areeva a WhatsApp message
  directly. Swap this file later if you want email instead/as well.
- `src/server.js` - the web server that ties it all together: receives
  webhooks from Meta, runs the flow, sends replies.

## Your actual Meta credentials (already obtained)

You've already completed the Meta dashboard setup. These are your real values:

- **Phone Number ID:** `1179325298595196`
- **WhatsApp Business Account ID:** `1680078316608881`
- **Permanent access token:** generated from the `cssystem` system user (you copied this when it was generated, shown once only)

If you don't have the token saved anywhere, you'll need to go back into Meta Business Settings → Users → System Users → `cssystem` → Generate new token, and go through that process again (with the same two permissions: `whatsapp_business_messaging` and `whatsapp_business_management`).

The steps below assume you still have all three of these values ready to paste into Railway.

## Step 1: Get your WhatsApp Cloud API credentials from Meta

(Already done, see above - skip to Step 2 below.)

## Step 2: Set environment variables in Railway

In your Railway project, add a new service from this codebase (or this
repo, once pushed to GitHub), then set these variables:

| Variable | Value |
|---|---|
| `WHATSAPP_TOKEN` | Your permanent system user access token from Step 1 |
| `WHATSAPP_PHONE_NUMBER_ID` | The phone number ID from Meta's API Setup panel |
| `WHATSAPP_VERIFY_TOKEN` | Any string you make up yourself, e.g. `chai-society-2026`. You'll enter this exact same string into Meta's webhook config in Step 3. |
| `AREEVA_WHATSAPP_NUMBER` | Areeva's WhatsApp number in international format with no `+` or spaces, e.g. `27821234567`. Leave unset to just log notifications instead of sending them, until you've confirmed this works. |
| `ADMIN_RESET_KEY` | Any string you make up, used only to let you manually reset a test conversation via the `/admin/reset-session` endpoint. |

## Step 3: Point Meta's webhook at your Railway URL

1. Once deployed, Railway gives you a public URL, e.g.
   `https://chai-society-whatsapp-bot.up.railway.app`
2. In Meta's App Dashboard > WhatsApp > Configuration, set the webhook
   **Callback URL** to `https://YOUR-RAILWAY-URL/webhook`
3. Set the **Verify Token** to the exact same string you used for
   `WHATSAPP_VERIFY_TOKEN` in Step 2.
4. Click Verify and Save. Meta will call your `/webhook` endpoint once
   to confirm it's reachable, this app handles that automatically.
5. Subscribe the webhook to the `messages` field, so incoming messages
   actually get delivered to your app.

## Step 4: Test it

Message your Chai Society WhatsApp number from a different phone. You
should get the full conversation flow exactly as tested in Typebot:
event type question, guest count, the under-10 website deflection (if
you pick that), event date, budget, a product-aware recommendation,
company/name, special notes (worded around theme/fit, never
"customisation"), and finally the intent checkpoint asking if you want
to be contacted - ending in either a warm handoff (with Areeva
notified) or a graceful "not right now."

To reset your own test conversation back to the start without waiting,
call:
```
curl -X POST https://YOUR-RAILWAY-URL/admin/reset-session \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "27821111111", "adminKey": "YOUR_ADMIN_RESET_KEY"}'
```

## Known limitations, stated honestly

- **Session storage is in-memory.** If Railway restarts the service
  (a redeploy, a crash, routine maintenance), anyone mid-conversation
  at that exact moment has to start over. At Chai Society's current
  lead volume this is a reasonable tradeoff for getting started; if it
  becomes a problem, the fix is adding Railway's Postgres add-on and
  changing only `src/store.js`.
- **No retry/backoff on WhatsApp API failures.** If a send fails (rate
  limit, token expiry, network blip), it's logged but not automatically
  retried. Worth keeping an eye on Railway's logs initially.
- **Areeva's notification is WhatsApp-only for now**, and only fires if
  `AREEVA_WHATSAPP_NUMBER` is set. Until that's configured, qualified
  leads are still captured (visible in Railway's logs) but nobody gets
  pinged automatically, this was true of every option discussed earlier
  too; building the actual notification speed up is the agreed next
  phase of work.
- **List messages cap at 10 options per list** on WhatsApp's side. All
  the flow's current question lists are well under that, so this isn't
  a current problem, just worth knowing if more options get added later.

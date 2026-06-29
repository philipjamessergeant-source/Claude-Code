require("dotenv").config();
const express = require("express");
const { flow } = require("./flow");
const { resetSession, processSession } = require("./store");
const { sendMessages, parseIncomingMessage } = require("./whatsapp");
const { notifyAreeva } = require("./notifyAreeva");
const { runRetargetingCheck, handlePotentialAreevaCommand } = require("./retargeting");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Webhook verification (Meta calls this once when you register the URL) ───
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook verified successfully");
    return res.status(200).send(challenge);
  }
  console.warn("Webhook verification failed");
  return res.sendStatus(403);
});

// ─── Incoming WhatsApp messages ────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Always respond 200 quickly - Meta retries aggressively on non-200s,
  // and we don't want duplicate processing if our own logic is slow.
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      // This is most likely a status update (delivered/read receipt),
      // not an actual incoming message - nothing to do.
      return;
    }

    const fromPhoneNumber = message.from;
    const { text, buttonId } = parseIncomingMessage(message);

    console.log(`Incoming message from ${fromPhoneNumber}: "${text}" (buttonId: ${buttonId})`);

    // If this message is Areeva replying YES/SKIP to a retargeting
    // approval request, handle it here and stop - it's not a real lead
    // message and shouldn't be run through the normal qualification flow.
    const wasAreevaCommand = await handlePotentialAreevaCommand(fromPhoneNumber, text);
    if (wasAreevaCommand) {
      return;
    }

    // processSession locks this phone number's session row for the
    // duration of the transaction, so if two messages arrive close
    // together (e.g. during a burst of new ad traffic), the second one
    // waits for the first to fully commit before reading - preventing
    // the stale-read race that was silently dropping sessionUpdates and
    // causing some conversations to stall before reaching awaiting_intent.
    const { result, updatedSession } = await processSession(fromPhoneNumber, async (session) => {
      const handler = flow[session.state] || flow.start;
      return handler(session, text, buttonId);
    });

    await sendMessages(fromPhoneNumber, result.messages);

    if (result.triggerAreevaNotification) {
      await notifyAreeva(updatedSession, result.areevaNotificationType);
    }
  } catch (err) {
    console.error("Error handling incoming message:", err);
  }
});

// ─── Manual reset endpoint, useful for testing ─────────────────────────────
// Call this (e.g. via Postman or curl) to reset a phone number's
// conversation state back to the start, without waiting for a real
// WhatsApp message. Not exposed to end users.
app.post("/admin/reset-session", async (req, res) => {
  const { phoneNumber, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_RESET_KEY) {
    return res.sendStatus(403);
  }
  await resetSession(phoneNumber);
  return res.json({ reset: true, phoneNumber });
});

// ─── Retargeting: daily check trigger ──────────────────────────────────────
// This endpoint runs the retargeting check described in retargeting.js -
// finds leads who said "not now" 3+ days ago, and sends Areeva a WhatsApp
// message per candidate asking her to approve or skip. Point Railway's
// Cron Schedule (Settings -> Deploy -> Cron Schedule) at this endpoint
// once daily, e.g. "0 9 * * *" for 9am, with the ADMIN_RESET_KEY in the
// request body.
app.post("/admin/retargeting/run-check", async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_RESET_KEY) {
    return res.sendStatus(403);
  }
  const result = await runRetargetingCheck();
  return res.json(result);
});

// ─── Health check ───────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Chai Society WhatsApp lead qualification bot is running \u2705" });
});

app.listen(PORT, () => console.log(`\u2705 Chai Society WhatsApp bot running on port ${PORT}`));

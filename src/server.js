require("dotenv").config();
const express = require("express");
const { flow } = require("./flow");
const { getSession, saveSession, resetSession } = require("./store");
const { sendMessages, parseIncomingMessage } = require("./whatsapp");
const { notifyAreeva } = require("./notifyAreeva");

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

  // TEMPORARY DEBUG LOGGING - remove once the message flow is confirmed working.
  console.log("=== RAW WEBHOOK PAYLOAD ===");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("===========================");

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

    const session = getSession(fromPhoneNumber);
    const handler = flow[session.state] || flow.start;
    const result = handler(session, text, buttonId);

    saveSession(fromPhoneNumber, result);

    await sendMessages(fromPhoneNumber, result.messages);

    if (result.triggerAreevaNotification) {
      const updatedSession = getSession(fromPhoneNumber);
      await notifyAreeva(updatedSession);
    }
  } catch (err) {
    console.error("Error handling incoming message:", err);
  }
});

// ─── Manual reset endpoint, useful for testing ─────────────────────────────
// Call this (e.g. via Postman or curl) to reset a phone number's
// conversation state back to the start, without waiting for a real
// WhatsApp message. Not exposed to end users.
app.post("/admin/reset-session", (req, res) => {
  const { phoneNumber, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_RESET_KEY) {
    return res.sendStatus(403);
  }
  resetSession(phoneNumber);
  return res.json({ reset: true, phoneNumber });
});

// ─── Health check ───────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Chai Society WhatsApp lead qualification bot is running \u2705" });
});

app.listen(PORT, () => console.log(`\u2705 Chai Society WhatsApp bot running on port ${PORT}`));

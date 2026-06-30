/**
 * WhatsApp Cloud API client.
 *
 * Converts our internal message objects (from flow.js) into the exact
 * payload shape the WhatsApp Cloud API expects, and sends them via axios.
 *
 * Required environment variables (set these in Railway):
 *   WHATSAPP_TOKEN          - permanent system user access token
 *   WHATSAPP_PHONE_NUMBER_ID - the phone number ID from Meta's API Setup panel
 *   WHATSAPP_API_VERSION    - e.g. "v19.0" (optional, defaults below)
 */
const axios = require("axios");
const API_VERSION = process.env.WHATSAPP_API_VERSION || "v19.0";
function apiUrl() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;
}
function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };
}
/**
 * Converts one of our internal message objects into a WhatsApp Cloud API
 * payload. Supports three types:
 *   { type: "text", text: "..." }
 *   { type: "list", header, body, buttonText, options: [{id, title}] }
 *   { type: "buttons", body, options: [{id, title}] }
 *
 * WhatsApp's interactive list messages support a maximum of 10 rows per
 * list. All our option lists (event type, guest count, budget) are well
 * under that limit, so no pagination logic is needed here.
 *
 * WhatsApp's interactive reply buttons support a maximum of 3 buttons,
 * and crucially show each option as an immediately visible, tappable
 * button right in the chat - no extra "tap to open menu" step like
 * lists require. Use "buttons" instead of "list" for any 2-3 option
 * question where clarity matters most (e.g. the final yes/not-now
 * intent checkpoint), since customers were missing the list-style
 * prompt and assuming the conversation had already ended.
 */
function buildPayload(toPhoneNumber, message) {
  if (message.type === "text") {
    return {
      messaging_product: "whatsapp",
      to: toPhoneNumber,
      type: "text",
      text: { body: message.text },
    };
  }
  if (message.type === "list") {
    return {
      messaging_product: "whatsapp",
      to: toPhoneNumber,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: message.header },
        body: { text: message.body },
        action: {
          button: message.buttonText || "Choose an option",
          sections: [
            {
              title: message.header,
              rows: message.options.map((opt) => ({
                id: opt.id,
                title: opt.title,
              })),
            },
          ],
        },
      },
    };
  }
  if (message.type === "buttons") {
    return {
      messaging_product: "whatsapp",
      to: toPhoneNumber,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: message.body },
        action: {
          buttons: message.options.map((opt) => ({
            type: "reply",
            reply: { id: opt.id, title: opt.title },
          })),
        },
      },
    };
  }
  throw new Error(`Unknown message type: ${message.type}`);
}
async function sendMessage(toPhoneNumber, message) {
  const payload = buildPayload(toPhoneNumber, message);
  try {
    const response = await axios.post(apiUrl(), payload, { headers: authHeaders() });
    return response.data;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("Failed to send WhatsApp message:", JSON.stringify(detail));
    throw err;
  }
}
async function sendMessages(toPhoneNumber, messages) {
  const results = [];
  for (const message of messages) {
    // Sent sequentially (not in parallel) so they arrive in the same
    // order they were written, which matters for a conversational flow.
    const result = await sendMessage(toPhoneNumber, message);
    results.push(result);
  }
  return results;
}
/**
 * Sends an approved WhatsApp message template. Unlike sendMessage, this
 * works even outside the 24-hour customer service window - this is the
 * only reliable way to reach Areeva with lead notifications, since her
 * window with the bot number closes after 24 hours of inactivity and a
 * normal text message (sendMessage) silently fails after that point
 * (Meta error code 131047 - "Re-engagement message").
 *
 * `parameters` must be an array of strings, in order, matching the
 * {{1}}, {{2}}, {{3}}... variables in the approved template body.
 */
async function sendTemplateMessage(toPhoneNumber, templateName, languageCode, parameters) {
  const payload = {
    messaging_product: "whatsapp",
    to: toPhoneNumber,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components: [
        {
          type: "body",
          parameters: parameters.map((text) => ({ type: "text", text })),
        },
      ],
    },
  };

  try {
    const response = await axios.post(apiUrl(), payload, { headers: authHeaders() });
    return response.data;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("Failed to send WhatsApp template message:", JSON.stringify(detail));
    throw err;
  }
}
/**
 * Extracts the user's reply from an incoming webhook message object.
 * Returns { text, buttonId } - buttonId is set only if the user tapped
 * a list option or reply button; text is the raw text otherwise (or the
 * option's title, for logging/readability, when an option was tapped).
 */
function parseIncomingMessage(message) {
  if (message.type === "text") {
    return { text: message.text.body, buttonId: null };
  }
  if (message.type === "interactive") {
    const listReply = message.interactive?.list_reply;
    if (listReply) {
      return { text: listReply.title, buttonId: listReply.id };
    }
    const buttonReply = message.interactive?.button_reply;
    if (buttonReply) {
      return { text: buttonReply.title, buttonId: buttonReply.id };
    }
  }
  return { text: "", buttonId: null };
}
module.exports = { sendMessage, sendMessages, sendTemplateMessage, parseIncomingMessage };

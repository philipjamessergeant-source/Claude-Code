/**
 * Notifies Areeva when a lead completes qualification and confirms
 * genuine intent to be contacted (the "Yes, please reach out" branch).
 *
 * Uses an approved WhatsApp message template (chai_society_lead_notification)
 * rather than a free-form text message, because Areeva's WhatsApp
 * conversation window with the bot number closes after 24 hours of
 * inactivity on her side. A free-form message sent after that point
 * fails silently from the bot's perspective (Meta error code 131047),
 * even though the API call itself looks successful - this was
 * discovered the hard way, so don't revert to sendMessage for this.
 *
 * Template body (approved, Marketing category):
 *   New Chai Society lead: {{1}}
 *
 *   Event: {{2}}
 *   Guest count: {{3}}
 *   Budget: {{4}}
 *
 *   Status: {{5}}. Please follow up in WhatsApp.
 *
 * Required environment variable:
 *   AREEVA_WHATSAPP_NUMBER - Areeva's WhatsApp number in international
 *                            format, e.g. "27821234567" (no + or spaces)
 *   If this is not set, the module just logs instead of sending.
 */
const { sendTemplateMessage } = require("./whatsapp");

const TEMPLATE_NAME = "chai_society_lead_notification";
const TEMPLATE_LANGUAGE = "en";

const GUEST_COUNT_LABELS = {
  under_10: "Fewer than 10",
  "10_25": "10 to 25",
  "25_50": "25 to 50",
  "50_100": "50 to 100",
  "100_plus": "100+",
};
const BUDGET_LABELS = {
  under_5k: "Under R5,000",
  "5k_15k": "R5,000 - R15,000",
  "15k_30k": "R15,000 - R30,000",
  "30k_50k": "R30,000 - R50,000",
  "50k_plus": "R50,000+",
  unsure: "Not sure yet",
};
const EVENT_TYPE_LABELS = {
  wedding: "Wedding",
  conference: "Conference",
  high_tea: "High tea",
  corporate_event: "Corporate event",
  private_event: "Private event",
};

function formatLeadSummary(session, notificationType) {
  const d = session.data;
  const eventTypeLabel =
    d.eventType === "other" ? d.eventTypeOther : EVENT_TYPE_LABELS[d.eventType] || d.eventType || "-";
  const headerLine =
    notificationType === "not_now"
      ? "\uD83C\uDF3F Chai Society lead - not ready to be contacted yet"
      : "\uD83C\uDF3F New qualified Chai Society lead";
  const footerLine =
    notificationType === "not_now"
      ? "They said \"not right now\" when asked if we should reach out, so please do NOT contact them directly yet. Worth keeping for a future retargeting follow-up."
      : "They've confirmed they want to be contacted, this is a warm lead, please follow up promptly.";
  const lines = [
    headerLine,
    "",
    `From: ${session.phoneNumber}`,
    `Contact name: ${d.contactName || "-"}`,
    `Company: ${d.companyName || "Not company gifting, personal/individual enquiry"}`,
    `Event type: ${eventTypeLabel}`,
    `Guest count: ${GUEST_COUNT_LABELS[d.guestCount] || d.guestCount || "-"}`,
    `Event date: ${d.eventDate || "-"}`,
    `Budget tier: ${BUDGET_LABELS[d.budgetTier] || d.budgetTier || "-"}`,
    `Special notes: ${d.specialNotes || "-"}`,
    "",
    footerLine,
  ];
  return lines.join("\n");
}

/**
 * Builds the five {{1}}..{{5}} values for the approved template, in
 * order, from a session. Keeps the same underlying fields as the old
 * free-text summary, just condensed to fit the template's variables.
 */
function formatTemplateParameters(session, notificationType) {
  const d = session.data;
  const eventTypeLabel =
    d.eventType === "other" ? d.eventTypeOther : EVENT_TYPE_LABELS[d.eventType] || d.eventType || "-";
  const statusText = notificationType === "not_now" ? "Not ready to be contacted yet" : "Warm lead";

  return [
    d.contactName || session.phoneNumber,
    eventTypeLabel,
    GUEST_COUNT_LABELS[d.guestCount] || d.guestCount || "-",
    BUDGET_LABELS[d.budgetTier] || d.budgetTier || "-",
    statusText,
  ];
}

async function notifyAreeva(session, notificationType = "warm_handoff") {
  const summary = formatLeadSummary(session, notificationType);
  // Always log, regardless of whether a delivery channel is configured,
  // so the lead is never silently lost even if WhatsApp delivery fails.
  console.log("=== AREEVA NOTIFICATION ===");
  console.log(summary);
  console.log("===========================");

  const areevaNumber = process.env.AREEVA_WHATSAPP_NUMBER;
  if (!areevaNumber) {
    console.warn(
      "AREEVA_WHATSAPP_NUMBER is not set - notification was logged only, not sent. " +
        "Set this Railway environment variable once Areeva's number is confirmed."
    );
    return { delivered: false, reason: "AREEVA_WHATSAPP_NUMBER not configured" };
  }

  try {
    const parameters = formatTemplateParameters(session, notificationType);
    await sendTemplateMessage(areevaNumber, TEMPLATE_NAME, TEMPLATE_LANGUAGE, parameters);
    return { delivered: true };
  } catch (err) {
    console.error("Failed to notify Areeva via WhatsApp template:", err.message);
    return { delivered: false, reason: err.message };
  }
}

module.exports = { notifyAreeva, formatLeadSummary };

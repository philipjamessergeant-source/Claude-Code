/**
 * Notifies Areeva when a lead completes qualification and confirms
 * genuine intent to be contacted (the "Yes, please reach out" branch).
 *
 * This is intentionally left as a small, swappable module: right now it
 * logs the lead summary and optionally sends a WhatsApp message to
 * Areeva's own number using the same WhatsApp client this bot already
 * has. If Phil later wants email notifications instead (or as well),
 * this is the only file that needs to change - nothing in flow.js or
 * server.js needs to know how the notification is actually delivered.
 *
 * Required environment variable for the WhatsApp notification path:
 *   AREEVA_WHATSAPP_NUMBER - Areeva's WhatsApp number in international
 *                            format, e.g. "27821234567" (no + or spaces)
 *   If this is not set, the module just logs instead of sending.
 */

const { sendMessage } = require("./whatsapp");

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

function formatLeadSummary(session) {
  const d = session.data;
  const eventTypeLabel =
    d.eventType === "other" ? d.eventTypeOther : EVENT_TYPE_LABELS[d.eventType] || d.eventType || "-";

  const lines = [
    "\uD83C\uDF3F New qualified Chai Society lead",
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
    "They've confirmed they want to be contacted, this is a warm lead, please follow up promptly.",
  ];
  return lines.join("\n");
}

async function notifyAreeva(session) {
  const summary = formatLeadSummary(session);

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
    await sendMessage(areevaNumber, { type: "text", text: summary });
    return { delivered: true };
  } catch (err) {
    console.error("Failed to notify Areeva via WhatsApp:", err.message);
    return { delivered: false, reason: err.message };
  }
}

module.exports = { notifyAreeva, formatLeadSummary };

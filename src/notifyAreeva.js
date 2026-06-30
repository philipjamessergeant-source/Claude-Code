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
 * IMPORTANT: the WhatsApp template is only ever sent for warm_handoff
 * leads (customer said "Yes, please reach out"). For not_now leads
 * (customer said "Not right now"), we deliberately do NOT send Areeva
 * anything via WhatsApp - those leads are handled by the retargeting
 * cron job (see retargeting.js) days later, and pinging Areeva
 * immediately would contradict the customer's explicit request not to
 * be contacted yet. We still always log to Railway either way, so
 * nothing is ever silently lost - it's just not pushed to WhatsApp for
 * the not_now case.
 *
 * Template body (approved, Marketing category):
 *   New Chai Society lead: {{1}}
 *   Phone: {{2}}
 *   Company: {{3}}
 *
 *   Event: {{4}}
 *   Guest count: {{5}}
 *   Event date: {{6}}
 *   Budget: {{7}}
 *   Notes: {{8}}
 *
 *   Status: Warm lead - please follow up in WhatsApp.
 *
 * Required environment variable:
 *   AREEVA_WHATSAPP_NUMBER - Areeva's WhatsApp number in international
 *                            format, e.g. "27821234567" (no + or spaces)
 *   If this is not set, the module just logs instead of sending.
 *
 * Budget label note: under_5k is labelled "Flexible / let's discuss"
 * here to match the customer-facing button wording in flow.js. This was
 * previously "Under R5,000", which gave Areeva the original anchoring
 * impression flow.js was specifically changed to avoid - the underlying
 * id (under_5k) is unchanged, only this display label.
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
  under_5k: "Flexible / let's discuss",
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

/**
 * Sanitizes free-text customer input (specialNotes) before it's passed
 * into an approved WhatsApp template variable. Customer-typed text is
 * unpredictable - it could contain a URL, excessive length, or unusual
 * characters - and templates that pass raw user content into variables
 * are more likely to be flagged or rejected by Meta's review, and are
 * also just a bad idea to forward unfiltered regardless.
 */
function sanitizeForTemplate(text, maxLength = 100) {
  if (!text) return "-";

  let cleaned = text
    .replace(/https?:\/\/\S+/gi, "[link removed]") // strip URLs
    .replace(/\s+/g, " ") // collapse whitespace/newlines
    .trim();

  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength - 3).trim() + "...";
  }

  return cleaned || "-";
}

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
 * Builds the eight {{1}}..{{8}} values for the approved template, in
 * order. Only ever called for warm_handoff leads - see notifyAreeva.
 */
function formatTemplateParameters(session) {
  const d = session.data;
  const eventTypeLabel =
    d.eventType === "other" ? d.eventTypeOther : EVENT_TYPE_LABELS[d.eventType] || d.eventType || "-";

  return [
    d.contactName || session.phoneNumber,
    session.phoneNumber,
    d.companyName || "Not company gifting, personal/individual enquiry",
    eventTypeLabel,
    GUEST_COUNT_LABELS[d.guestCount] || d.guestCount || "-",
    d.eventDate || "-",
    BUDGET_LABELS[d.budgetTier] || d.budgetTier || "-",
    sanitizeForTemplate(d.specialNotes),
  ];
}

async function notifyAreeva(session, notificationType = "warm_handoff") {
  const summary = formatLeadSummary(session, notificationType);
  // Always log, regardless of whether a delivery channel is configured,
  // so the lead is never silently lost even if WhatsApp delivery fails.
  console.log("=== AREEVA NOTIFICATION ===");
  console.log(summary);
  console.log("===========================");

  // Only warm, confirmed leads get pushed to Areeva's WhatsApp. "Not
  // now" leads are deliberately left out of WhatsApp delivery - see the
  // file header comment for why - but they're still fully logged above,
  // and still picked up later by the retargeting cron job.
  if (notificationType !== "warm_handoff") {
    return { delivered: false, reason: "not_now leads are not sent to WhatsApp, log only" };
  }

  const areevaNumber = process.env.AREEVA_WHATSAPP_NUMBER;
  if (!areevaNumber) {
    console.warn(
      "AREEVA_WHATSAPP_NUMBER is not set - notification was logged only, not sent. " +
        "Set this Railway environment variable once Areeva's number is confirmed."
    );
    return { delivered: false, reason: "AREEVA_WHATSAPP_NUMBER not configured" };
  }

  try {
    const parameters = formatTemplateParameters(session);
    await sendTemplateMessage(areevaNumber, TEMPLATE_NAME, TEMPLATE_LANGUAGE, parameters);
    return { delivered: true };
  } catch (err) {
    console.error("Failed to notify Areeva via WhatsApp template:", err.message);
    return { delivered: false, reason: err.message };
  }
}

module.exports = { notifyAreeva, formatLeadSummary };

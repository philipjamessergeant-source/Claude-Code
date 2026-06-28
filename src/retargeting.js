/**
 * Retargeting for leads who said "not right now."
 *
 * Design, matching what was agreed:
 *   - 3 days after someone says "not right now," they become eligible
 *     for retargeting.
 *   - Areeva approves each one individually before anything is sent to
 *     the lead - this is NOT fully automatic. Sending unreviewed
 *     marketing messages at scale is exactly the kind of thing that
 *     erodes WhatsApp account quality if something's off (wrong tone,
 *     event date already passed, etc), so a human check stays in the
 *     loop.
 *
 * How the approval flow actually works day to day:
 *   1. A daily check (see runRetargetingCheck) finds everyone who hit
 *      the 3-day mark and hasn't been retargeted yet.
 *   2. For each one, Areeva gets a WhatsApp message summarising the
 *      lead and asking her to reply "YES <number>" to approve sending
 *      the retargeting message, or "SKIP <number>" to leave them alone.
 *   3. When Areeva replies, the webhook handler in server.js (via the
 *      isAreevaReply / handleAreevaReply functions below) checks if her
 *      message matches that pattern, and if so, sends the retargeting
 *      message to the original lead - all without anyone needing to
 *      open a dashboard.
 *
 * This file does NOT include a built-in scheduler (e.g. cron). Railway
 * has a "Cron Schedule" option in service settings (we saw this in the
 * Settings page during setup) - point that at hitting
 * POST /admin/retargeting/run-check once daily, with the ADMIN_RESET_KEY
 * in the body, and this file handles the rest. This keeps the
 * scheduling mechanism outside the application code, which is simpler
 * to adjust later (e.g. changing the time of day) without a redeploy.
 */

const { findStaleSoftDeclines, getSession, saveSession } = require("./store");
const { sendMessage } = require("./whatsapp");

const RETARGET_AFTER_DAYS = 3;

const EVENT_TYPE_LABELS = {
  wedding: "wedding",
  conference: "conference",
  high_tea: "high tea",
  corporate_event: "corporate gifting",
  private_event: "event",
};

function retargetingMessageFor(session) {
  const d = session.data;
  const eventLabel = EVENT_TYPE_LABELS[d.eventType] || "event";
  const name = d.contactName ? d.contactName : "there";

  return (
    `Hi ${name}, just checking in! We'd still love to help with the gifting for your ${eventLabel} ` +
    `if it's still on your radar. No pressure at all, just message us back here whenever suits, ` +
    `and we'll pick up right where we left off. \uD83C\uDF3F`
  );
}

/**
 * Finds everyone eligible for retargeting (3+ days in "not now," not yet
 * retargeted) and sends Areeva one approval-request message per lead.
 * Marks each as "awaiting Areeva's decision" so the same person doesn't
 * get queued for approval twice if this runs again before she replies.
 */
async function runRetargetingCheck() {
  const candidates = await findStaleSoftDeclines(RETARGET_AFTER_DAYS);
  const areevaNumber = process.env.AREEVA_WHATSAPP_NUMBER;

  if (!areevaNumber) {
    console.warn("AREEVA_WHATSAPP_NUMBER not set - cannot send retargeting approval requests.");
    return { checked: candidates.length, sentForApproval: 0, reason: "AREEVA_WHATSAPP_NUMBER not configured" };
  }

  let sentForApproval = 0;

  for (const session of candidates) {
    // Skip anyone already queued for Areeva's decision, so re-running
    // this check doesn't spam her with duplicate approval requests.
    if (session.data.retargetApprovalPending) {
      continue;
    }

    const d = session.data;
    const eventLabel = EVENT_TYPE_LABELS[d.eventType] || d.eventType || "event";

    const approvalRequest =
      `\uD83C\uDF3F Retargeting candidate (3+ days, said "not now")\n\n` +
      `Contact: ${d.contactName || "-"}\n` +
      `Company: ${d.companyName || "Personal enquiry"}\n` +
      `Event: ${eventLabel}, ${d.guestCount || "-"} guests, ${d.eventDate || "-"}\n` +
      `Budget: ${d.budgetTier || "-"}\n\n` +
      `Reply "YES ${session.phoneNumber}" to send them a check-in message, ` +
      `or "SKIP ${session.phoneNumber}" to leave them be.`;

    try {
      await sendMessage(areevaNumber, { type: "text", text: approvalRequest });
      await saveSession(session.phoneNumber, {
        sessionUpdates: { retargetApprovalPending: true },
      });
      sentForApproval += 1;
    } catch (err) {
      console.error(`Failed to send retargeting approval request for ${session.phoneNumber}:`, err.message);
    }
  }

  return { checked: candidates.length, sentForApproval };
}

/**
 * Checks if an incoming message (from Areeva's number specifically) is
 * a retargeting approval/skip command, and if so, acts on it. Returns
 * true if the message was handled as a retargeting command (so
 * server.js knows not to also run it through the normal lead flow),
 * false otherwise.
 */
async function handlePotentialAreevaCommand(fromPhoneNumber, text) {
  const areevaNumber = process.env.AREEVA_WHATSAPP_NUMBER;
  if (!areevaNumber || fromPhoneNumber !== areevaNumber) {
    return false;
  }

  const trimmed = (text || "").trim();
  const yesMatch = trimmed.match(/^YES\s+(\d+)$/i);
  const skipMatch = trimmed.match(/^SKIP\s+(\d+)$/i);

  if (yesMatch) {
    const leadPhoneNumber = yesMatch[1];
    const session = await getSession(leadPhoneNumber);
    const message = retargetingMessageFor(session);

    await sendMessage(leadPhoneNumber, { type: "text", text: message });
    await saveSession(leadPhoneNumber, {
      sessionUpdates: { retargeted: true, retargetApprovalPending: false },
    });
    await sendMessage(areevaNumber, { type: "text", text: `Sent! \u2705 ${leadPhoneNumber} has been retargeted.` });
    return true;
  }

  if (skipMatch) {
    const leadPhoneNumber = skipMatch[1];
    await saveSession(leadPhoneNumber, {
      sessionUpdates: { retargeted: true, retargetApprovalPending: false, retargetSkipped: true },
    });
    await sendMessage(areevaNumber, { type: "text", text: `Noted, skipping ${leadPhoneNumber}.` });
    return true;
  }

  return false;
}

module.exports = {
  runRetargetingCheck,
  handlePotentialAreevaCommand,
  retargetingMessageFor,
  RETARGET_AFTER_DAYS,
};

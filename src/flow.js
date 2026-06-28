/**
 * Chai Society - Events & Corporate Gifting Lead Qualification Flow
 *
 * This is a state machine reimplementation of the flow originally built and
 * tested in Typebot. Each conversation step is a "state". The bot tracks
 * which state a phone number is currently in (see store.js) and this file
 * decides, given the current state and the user's incoming message, what
 * to send back and which state to move to next.
 *
 * Design notes carried over from the approved Typebot flow:
 * - Below 10 recipients -> deflect to the B2C website, no Areeva handoff.
 * - 10+ recipients -> full qualification: event type, date, budget,
 *   product-aware (non-committal) recommendation, company/name, special
 *   notes (worded as "theme/audience fit", never "customisation" or
 *   "colour palette", since Chai Society does not offer bespoke boxes),
 *   then an explicit intent checkpoint before any handoff to Areeva.
 * - The closing language is honest about response time ("shortly"), not
 *   "1-2 business days", and explicitly stays on WhatsApp throughout.
 */

const PRODUCTS = {
  dailyRitual: { name: "The Daily Ritual", price: 620 },
  brewersChoice: { name: "The Brewer's Choice", price: 670 },
  sommeliersSet: { name: "The Sommelier's Set", price: 980 },
  heritageCollection: { name: "The Heritage Collection", price: 1260 },
};

const EVENT_TYPE_OPTIONS = [
  { id: "wedding", title: "Wedding" },
  { id: "conference", title: "Conference" },
  { id: "high_tea", title: "High tea" },
  { id: "corporate_event", title: "Corporate event" },
  { id: "private_event", title: "Private event" },
  { id: "other", title: "Other" },
];

const GUEST_COUNT_OPTIONS = [
  { id: "under_10", title: "Fewer than 10" },
  { id: "10_25", title: "10 to 25" },
  { id: "25_50", title: "25 to 50" },
  { id: "50_100", title: "50 to 100" },
  { id: "100_plus", title: "100+" },
];

const BUDGET_OPTIONS = [
  { id: "under_5k", title: "Under R5,000" },
  { id: "5k_15k", title: "R5,000 - R15,000" },
  { id: "15k_30k", title: "R15,000 - R30,000" },
  { id: "30k_50k", title: "R30,000 - R50,000" },
  { id: "50k_plus", title: "R50,000+" },
  { id: "unsure", title: "Not sure yet" },
];

const HAS_COMPANY_OPTIONS = [
  { id: "yes", title: "Yes" },
  { id: "no", title: "No, just for me" },
];

const INTENT_OPTIONS = [
  { id: "yes_contact", title: "Yes, please reach out" },
  { id: "not_now", title: "Not right now" },
];

const EVENT_TYPE_LABELS_FOR_RESUME = {
  wedding: "wedding",
  conference: "conference",
  high_tea: "high tea",
  corporate_event: "corporate gifting",
  private_event: "event",
};

function eventTypeReaction(eventType) {
  switch (eventType) {
    case "wedding":
      return "Oh, congratulations! We'd love to be part of the celebration.";
    case "conference":
      return "Lovely, conferences are actually one of our favourite types of events to gift for.";
    case "high_tea":
      return "A high tea, how perfect, that's quite literally what we do best.";
    case "corporate_event":
      return "That sounds great, we love helping make corporate moments feel a little more thoughtful.";
    case "private_event":
      return "That sounds lovely, we'd be glad to help make it memorable.";
    default:
      return "That sounds wonderful, we'd love to help make it memorable.";
  }
}

function specialNotesQuestion(eventType) {
  switch (eventType) {
    case "wedding":
      return "Is there a theme or feel to the day we should keep in mind, so we can point you to the option that fits best?";
    case "conference":
      return "Is there a theme for the conference, or anything about the audience, we should keep in mind so we can suggest the right fit?";
    case "high_tea":
      return "Is there a theme or feel for the high tea we should keep in mind, so we can suggest the right fit from our range?";
    case "corporate_event":
      return "Is there anything about the occasion or the people receiving these we should keep in mind, so we can point you to the right option?";
    case "private_event":
      return "Is there a theme or feel to the occasion we should keep in mind, so we can point you to the right option?";
    default:
      return "Is there anything about the occasion we should keep in mind, so we can point you to the right option from our range?";
  }
}

function intentCheckpointMessage(eventType) {
  const eventLabel = {
    wedding: "your wedding",
    conference: "your conference",
    high_tea: "your high tea",
    corporate_event: "your gifting",
    private_event: "your event",
  }[eventType] || "your gifting";

  const openLine = {
    wedding: "This sounds like exactly the kind of celebration we love being part of",
    conference: "This sounds like a great fit for us",
    high_tea: "This sounds lovely, we'd really enjoy being part of it",
    corporate_event: "This sounds like exactly the kind of corporate gifting we love being part of",
    private_event: "This sounds lovely, we'd really enjoy being part of it",
  }[eventType] || "This sounds like exactly the kind of thing we love being part of";

  return `${openLine} \uD83D\uDC9B I can have someone from our team jump into this exact WhatsApp chat today to talk through real options for ${eventLabel} and your budget. Should I get them in here for you?`;
}

function recommendationText(budgetTier) {
  switch (budgetTier) {
    case "under_5k":
      return "At this budget for a group of this size, we'd genuinely love to chat through what's realistic together rather than guess, our team will talk you through real options once we connect.";
    case "5k_15k":
      return `Based on what you've shared, something in the style of ${PRODUCTS.dailyRitual.name} or ${PRODUCTS.brewersChoice.name} tends to work beautifully at this scale, simple, warm, and well-loved without overcomplicating things.`;
    case "15k_30k":
      return `For this kind of event, a lot of our clients lean toward ${PRODUCTS.sommeliersSet.name}, it feels considered without being over the top, and travels well for a larger group.`;
    case "30k_50k":
      return `At this scale, ${PRODUCTS.heritageCollection.name} is often the right fit, it's our complete experience, all four blends, and reads as a proper occasion gift rather than just a token.`;
    case "50k_plus":
      return "For an order of this size, we'd genuinely love to put together something a little more bespoke for you, our team will talk you through a tailored selection once we connect.";
    case "unsure":
    default:
      return `No problem at all, we work across a few ranges, from something simple and lovely like ${PRODUCTS.dailyRitual.name} through to ${PRODUCTS.heritageCollection.name} for a fuller experience. We'll talk through what fits best once we understand a bit more about the event.`;
  }
}

/**
 * Each state handler receives:
 *   - session: the current session object for this phone number (see store.js)
 *   - userText: the raw text the user sent (for free-text states)
 *   - userButtonId: the id of the button/list option the user selected (for choice states), or null
 * It must return:
 *   { messages: [ ...outgoing message objects... ], nextState: "state_name", sessionUpdates: { ...fields to merge into session.data... } }
 */
const flow = {
  // Entry point - triggered on first inbound message from a number with no session yet.
  start(session) {
    return {
      messages: [
        { type: "text", text: "Hi there! Thank you so much for reaching out to Chai Society \uD83C\uDF3F" },
        { type: "text", text: "We'd love to be part of your event. Tell me a bit about what you're planning?" },
        {
          type: "list",
          header: "Event type",
          body: "What kind of event is this for?",
          buttonText: "Choose an option",
          options: EVENT_TYPE_OPTIONS,
        },
      ],
      nextState: "awaiting_event_type",
      sessionUpdates: {},
    };
  },

  awaiting_event_type(session, userText, userButtonId) {
    const eventType = userButtonId;
    if (!eventType) {
      return {
        messages: [
          {
            type: "list",
            header: "Event type",
            body: "Please choose one of the options below so we know how to help.",
            buttonText: "Choose an option",
            options: EVENT_TYPE_OPTIONS,
          },
        ],
        nextState: "awaiting_event_type",
        sessionUpdates: {},
      };
    }

    if (eventType === "other") {
      return {
        messages: [{ type: "text", text: "Ooh, tell me more, what's the event?" }],
        nextState: "awaiting_event_type_other",
        sessionUpdates: { eventType: "other" },
      };
    }

    return {
      messages: [
        { type: "text", text: eventTypeReaction(eventType) },
        {
          type: "list",
          header: "Guest count",
          body: "Exciting! Roughly how many guests or recipients are you thinking of gifting for?",
          buttonText: "Choose an option",
          options: GUEST_COUNT_OPTIONS,
        },
      ],
      nextState: "awaiting_guest_count",
      sessionUpdates: { eventType },
    };
  },

  awaiting_event_type_other(session, userText) {
    return {
      messages: [
        { type: "text", text: eventTypeReaction("other") },
        {
          type: "list",
          header: "Guest count",
          body: "Exciting! Roughly how many guests or recipients are you thinking of gifting for?",
          buttonText: "Choose an option",
          options: GUEST_COUNT_OPTIONS,
        },
      ],
      nextState: "awaiting_guest_count",
      sessionUpdates: { eventTypeOther: userText },
    };
  },

  awaiting_guest_count(session, userText, userButtonId) {
    const guestCount = userButtonId;
    if (!guestCount) {
      return {
        messages: [
          {
            type: "list",
            header: "Guest count",
            body: "Please choose one of the options below.",
            buttonText: "Choose an option",
            options: GUEST_COUNT_OPTIONS,
          },
        ],
        nextState: "awaiting_guest_count",
        sessionUpdates: {},
      };
    }

    if (guestCount === "under_10") {
      return {
        messages: [
          {
            type: "text",
            text: "For orders under 10, the quickest way to get exactly what you're after is straight through our website, you'll see the full range and can check out in just a couple of minutes: chaisociety.co.za/collections/tea-gift-boxes",
          },
          {
            type: "text",
            text: "And if your numbers grow beyond 10 down the line, or you'd like something tailored for the event, message us back here, we'd love to help.",
          },
        ],
        nextState: "ended_b2c_deflect",
        sessionUpdates: { guestCount },
      };
    }

    return {
      messages: [
        {
          type: "text",
          text: "Lovely, that's a good size group to work with. When's the big day, or when would you need everything sorted by?",
        },
      ],
      nextState: "awaiting_event_date",
      sessionUpdates: { guestCount },
    };
  },

  awaiting_event_date(session, userText) {
    return {
      messages: [
        { type: "text", text: "Got it, noted \uD83D\uDCC5" },
        {
          type: "list",
          header: "Budget",
          body: "And do you have a budget in mind for the gifting? Totally fine if it's a rough range, just helps us think in the right direction for you.",
          buttonText: "Choose an option",
          options: BUDGET_OPTIONS,
        },
      ],
      nextState: "awaiting_budget",
      sessionUpdates: { eventDate: userText },
    };
  },

  awaiting_budget(session, userText, userButtonId) {
    const budgetTier = userButtonId;
    if (!budgetTier) {
      return {
        messages: [
          {
            type: "list",
            header: "Budget",
            body: "Please choose one of the ranges below.",
            buttonText: "Choose an option",
            options: BUDGET_OPTIONS,
          },
        ],
        nextState: "awaiting_budget",
        sessionUpdates: {},
      };
    }

    return {
      messages: [
        { type: "text", text: recommendationText(budgetTier) },
        { type: "text", text: "One more thing, what's your name?" },
      ],
      nextState: "awaiting_contact_name",
      sessionUpdates: { budgetTier },
    };
  },

  awaiting_contact_name(session, userText) {
    return {
      messages: [
        {
          type: "list",
          header: "Company",
          body: `Lovely to meet you, ${userText}. Is this enquiry on behalf of a company or organisation?`,
          buttonText: "Choose an option",
          options: HAS_COMPANY_OPTIONS,
        },
      ],
      nextState: "awaiting_has_company",
      sessionUpdates: { contactName: userText },
    };
  },

  awaiting_has_company(session, userText, userButtonId) {
    const hasCompany = userButtonId;
    if (!hasCompany) {
      return {
        messages: [
          {
            type: "list",
            header: "Company",
            body: "Please choose one of the options below.",
            buttonText: "Choose an option",
            options: HAS_COMPANY_OPTIONS,
          },
        ],
        nextState: "awaiting_has_company",
        sessionUpdates: {},
      };
    }

    if (hasCompany === "yes") {
      return {
        messages: [{ type: "text", text: "Great, what's the company or organisation's name?" }],
        nextState: "awaiting_company_name",
        sessionUpdates: {},
      };
    }

    const eventType = session.data.eventType;
    return {
      messages: [{ type: "text", text: specialNotesQuestion(eventType) }],
      nextState: "awaiting_special_notes",
      sessionUpdates: { companyName: null },
    };
  },

  awaiting_company_name(session, userText) {
    const eventType = session.data.eventType;
    return {
      messages: [{ type: "text", text: specialNotesQuestion(eventType) }],
      nextState: "awaiting_special_notes",
      sessionUpdates: { companyName: userText },
    };
  },

  awaiting_special_notes(session, userText) {
    const eventType = session.data.eventType;
    return {
      messages: [
        {
          type: "list",
          header: "Next step",
          body: intentCheckpointMessage(eventType),
          buttonText: "Choose an option",
          options: INTENT_OPTIONS,
        },
      ],
      nextState: "awaiting_intent",
      sessionUpdates: { specialNotes: userText },
    };
  },

  awaiting_intent(session, userText, userButtonId) {
    const wantsContact = userButtonId;
    if (!wantsContact) {
      return {
        messages: [
          {
            type: "list",
            header: "Next step",
            body: "Just to confirm, should we go ahead?",
            buttonText: "Choose an option",
            options: INTENT_OPTIONS,
          },
        ],
        nextState: "awaiting_intent",
        sessionUpdates: {},
      };
    }

    if (wantsContact === "not_now") {
      return {
        messages: [
          {
            type: "text",
            text: "No problem at all! Everything you've shared is saved right here, so whenever you're ready, just message us back in this chat and we'll pick up exactly where we left off. We hope your event is wonderful \uD83C\uDF3F",
          },
        ],
        nextState: "ended_soft_decline",
        sessionUpdates: { wantsContact: "not_now" },
        triggerAreevaNotification: true,
        areevaNotificationType: "not_now",
      };
    }

    return {
      messages: [
        {
          type: "text",
          text: "Brilliant! One of our team will jump into this exact chat shortly to talk through options tailored to your event and budget, all right here on WhatsApp, no need to switch channels. Speak soon! \uD83C\uDF3F",
        },
      ],
      nextState: "ended_warm_handoff",
      sessionUpdates: { wantsContact: "yes" },
      triggerAreevaNotification: true,
      areevaNotificationType: "warm_handoff",
    };
  },

  // Terminal states.
  ended_b2c_deflect(session, userText) {
    return flow.start(session);
  },

  // If someone who said "not right now" messages back, don't restart from
  // zero - acknowledge them by name (if we have it) and ask directly
  // whether they're ready to move forward, since we already have all
  // their event details saved in session.data.
  ended_soft_decline(session, userText) {
    const d = session.data;
    const hasDetails = d.eventType && d.guestCount && d.budgetTier;

    if (!hasDetails) {
      // Safety fallback: if for some reason we don't actually have their
      // details saved (e.g. they declined very early), just restart cleanly
      // rather than referencing information we don't have.
      return flow.start(session);
    }

    const greeting = d.contactName ? `Hi ${d.contactName}, lovely to hear from you again!` : "Hi again, lovely to hear from you!";

    return {
      messages: [
        {
          type: "list",
          header: "Next step",
          body: `${greeting} We've still got everything you shared with us earlier about your ${
            EVENT_TYPE_LABELS_FOR_RESUME[d.eventType] || "event"
          }. Would you like our team to jump into this chat now to talk through options?`,
          buttonText: "Choose an option",
          options: INTENT_OPTIONS,
        },
      ],
      nextState: "awaiting_intent",
      sessionUpdates: {},
    };
  },

  ended_warm_handoff(session, userText) {
    return flow.start(session);
  },
};

module.exports = { flow, PRODUCTS };

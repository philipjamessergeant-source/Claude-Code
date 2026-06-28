/**
 * Session store - tracks conversation state per WhatsApp phone number.
 *
 * This is an in-memory store: it works fine for getting started and for
 * moderate lead volume, but it resets if the Railway service restarts or
 * redeploys (any leads mid-conversation at that exact moment would have
 * to start over). For Chai Society's current volume this is a reasonable
 * starting point. If this becomes a problem later, swap this file's
 * implementation for a real database (Railway's own Postgres add-on is
 * the natural upgrade) - getSession/saveSession's signatures can stay
 * the same, so nothing else in the codebase needs to change.
 */

const sessions = new Map();

function getSession(phoneNumber) {
  if (!sessions.has(phoneNumber)) {
    sessions.set(phoneNumber, {
      phoneNumber,
      state: "start",
      data: {},
      updatedAt: new Date().toISOString(),
    });
  }
  return sessions.get(phoneNumber);
}

function saveSession(phoneNumber, updates) {
  const session = getSession(phoneNumber);
  if (updates.nextState) {
    session.state = updates.nextState;
  }
  if (updates.sessionUpdates) {
    Object.assign(session.data, updates.sessionUpdates);
  }
  session.updatedAt = new Date().toISOString();
  sessions.set(phoneNumber, session);
  return session;
}

function resetSession(phoneNumber) {
  sessions.delete(phoneNumber);
}

module.exports = { getSession, saveSession, resetSession };

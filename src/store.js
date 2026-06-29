/**
 * Session store - tracks conversation state per WhatsApp phone number.
 *
 * This is a Postgres-backed store, so paused conversations (e.g. someone
 * who said "not right now" and might come back days later, or who needs
 * to be retargeted after a few days) survive Railway restarts, crashes,
 * and redeploys. This replaces the original in-memory version, which
 * would silently lose all paused conversations on any restart - fine for
 * same-session use, not safe for anything that needs to persist across
 * days.
 *
 * Setup required in Railway:
 *   1. Add the Postgres plugin to this project (Railway dashboard -> New
 *      -> Database -> Add PostgreSQL). Railway automatically provides a
 *      DATABASE_URL environment variable once added - no manual wiring
 *      needed beyond that.
 *   2. That's it. This file creates its own table automatically on first
 *      run (see ensureTable below).
 *
 * Concurrency note: processSession() wraps the read-handle-write cycle in
 * a single Postgres transaction using SELECT ... FOR UPDATE. This means
 * if two WhatsApp messages from the same phone number arrive at nearly
 * the same time (common during traffic bursts from active ad campaigns),
 * the second one waits for the first to fully finish reading, updating,
 * and committing before it gets its turn - instead of both reading stale
 * data and one silently overwriting the other's progress.
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
});

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      phone_number TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  tableReady = true;
}

async function getSession(phoneNumber) {
  await ensureTable();

  const existing = await pool.query(
    `SELECT phone_number, state, data, updated_at FROM whatsapp_sessions WHERE phone_number = $1`,
    [phoneNumber]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    return {
      phoneNumber: row.phone_number,
      state: row.state,
      data: row.data,
      updatedAt: row.updated_at,
    };
  }

  const fresh = {
    phoneNumber,
    state: "start",
    data: {},
    updatedAt: new Date().toISOString(),
  };

  await pool.query(
    `INSERT INTO whatsapp_sessions (phone_number, state, data) VALUES ($1, $2, $3)
     ON CONFLICT (phone_number) DO NOTHING`,
    [fresh.phoneNumber, fresh.state, fresh.data]
  );

  return fresh;
}

/**
 * Runs the full read -> handle -> write cycle for one incoming message,
 * inside a single Postgres transaction with a row lock on this phone
 * number's session. `handlerFn` receives the locked, up-to-date session
 * and must return the same { messages, nextState, sessionUpdates,
 * triggerAreevaNotification, areevaNotificationType } shape the flow
 * handlers already return.
 *
 * Why this matters: if two messages from the same number arrive close
 * together, the second call's SELECT ... FOR UPDATE will block until the
 * first transaction commits, so it always sees the first message's
 * result before deciding what to do with the second. No more silently
 * stale reads, no more lost sessionUpdates.
 */
async function processSession(phoneNumber, handlerFn) {
  await ensureTable();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT phone_number, state, data FROM whatsapp_sessions WHERE phone_number = $1 FOR UPDATE`,
      [phoneNumber]
    );

    let session;
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      session = { phoneNumber: row.phone_number, state: row.state, data: row.data };
    } else {
      session = { phoneNumber, state: "start", data: {} };
      await client.query(
        `INSERT INTO whatsapp_sessions (phone_number, state, data) VALUES ($1, $2, $3)`,
        [session.phoneNumber, session.state, session.data]
      );
    }

    const result = await handlerFn(session);

    const newState = result.nextState || session.state;
    const newData = result.sessionUpdates ? { ...session.data, ...result.sessionUpdates } : session.data;

    await client.query(
      `UPDATE whatsapp_sessions SET state = $2, data = $3, updated_at = now() WHERE phone_number = $1`,
      [phoneNumber, newState, newData]
    );

    await client.query("COMMIT");

    return { result, updatedSession: { phoneNumber, state: newState, data: newData } };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function saveSession(phoneNumber, updates) {
  await ensureTable();

  const session = await getSession(phoneNumber);

  const newState = updates.nextState || session.state;
  const newData = updates.sessionUpdates ? { ...session.data, ...updates.sessionUpdates } : session.data;

  await pool.query(
    `INSERT INTO whatsapp_sessions (phone_number, state, data, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (phone_number)
     DO UPDATE SET state = $2, data = $3, updated_at = now()`,
    [phoneNumber, newState, newData]
  );

  return { phoneNumber, state: newState, data: newData, updatedAt: new Date().toISOString() };
}

async function resetSession(phoneNumber) {
  await ensureTable();
  await pool.query(`DELETE FROM whatsapp_sessions WHERE phone_number = $1`, [phoneNumber]);
}
/**
 * Used by the retargeting job (see retargeting.js) to find leads who
 * said "not right now" a specific number of days ago and haven't been
 * retargeted yet.
 */
async function findStaleSoftDeclines(daysAgo) {
  await ensureTable();
  const result = await pool.query(
    `SELECT phone_number, state, data, updated_at FROM whatsapp_sessions
     WHERE state = 'ended_soft_decline'
       AND (data->>'retargeted') IS NULL
       AND updated_at <= now() - ($1 || ' days')::interval`,
    [daysAgo]
  );
  return result.rows.map((row) => ({
    phoneNumber: row.phone_number,
    state: row.state,
    data: row.data,
    updatedAt: row.updated_at,
  }));
}

/**
 * Finds leads who answered enough to be useful (they reached at least
 * awaiting_special_notes or awaiting_intent - meaning they have an event
 * type, guest count, and budget on file) but never triggered the original
 * Areeva notification, because their session stalled before reaching
 * awaiting_intent. This was caused by a race condition in the old
 * getSession/saveSession pair, fixed by processSession.
 *
 * Excludes anyone already in a terminal state (ended_warm_handoff,
 * ended_soft_decline, ended_b2c_deflect) since those already went
 * through the normal notification path and shouldn't be double-notified.
 *
 * Excludes anyone already marked notifiedStalled: true, so this function
 * is safe to run more than once - it only picks up genuinely new finds
 * each time.
 */
async function findStalledLeads() {
  await ensureTable();
  const result = await pool.query(`
    SELECT phone_number, state, data, updated_at FROM whatsapp_sessions
    WHERE state IN ('awaiting_special_notes', 'awaiting_intent')
      AND data->>'budgetTier' IS NOT NULL
      AND (data->>'notifiedStalled') IS NULL
  `);
  return result.rows.map((row) => ({
    phoneNumber: row.phone_number,
    state: row.state,
    data: row.data,
    updatedAt: row.updated_at,
  }));
}

/**
 * Marks a session as having been picked up by the stalled-leads notifier,
 * so re-running findStalledLeads/notify-stalled-leads later won't
 * re-notify Areeva about the same lead.
 */
async function markStalledNotified(phoneNumber) {
  await ensureTable();
  await pool.query(
    `UPDATE whatsapp_sessions
     SET data = data || '{"notifiedStalled": true}'::jsonb, updated_at = now()
     WHERE phone_number = $1`,
    [phoneNumber]
  );
}

module.exports = {
  getSession,
  saveSession,
  resetSession,
  findStaleSoftDeclines,
  processSession,
  findStalledLeads,
  markStalledNotified,
};

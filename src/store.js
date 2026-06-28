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
 * getSession/saveSession/resetSession are now async (they return
 * Promises), since they talk to a real database instead of an in-memory
 * Map. Every call site in server.js and flow.js has been updated to
 * await them.
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

module.exports = { getSession, saveSession, resetSession, findStaleSoftDeclines };

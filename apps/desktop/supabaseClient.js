/**
 * Supabase client for Mikaju Payroll (main process).
 *
 * Uses the shared Supabase project (wznopthjoaqusalqoyru) with the `mikaju`
 * schema — keeping Mikaju's data completely separate from the salary
 * calculator's `public` schema while sharing auth.users between both products.
 *
 * Reads MIKAJU_DB_URL and MIKAJU_DB_ANON_KEY — not SUPABASE_* — because
 * the SUPABASE_ prefix is reserved by the Supabase CLI.
 */
const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getSupabaseClient() {
  if (_client) return _client;

  const url     = process.env.MIKAJU_DB_URL;
  const anonKey = process.env.MIKAJU_DB_ANON_KEY;

  if (!url || !anonKey) {
    console.warn(
      '[Mikaju] MIKAJU_DB_URL / MIKAJU_DB_ANON_KEY not set in .env — ' +
      'running in offline-only mode until configured.'
    );
    return null;
  }

  _client = createClient(url, anonKey, {
    db: {
      schema: 'mikaju',         // separates Mikaju from the calculator's `public` schema
    },
    auth: {
      persistSession: true,
      storageKey: 'mikaju-auth', // distinct storage key from the calculator's session
    },
  });

  return _client;
}

module.exports = { getSupabaseClient };

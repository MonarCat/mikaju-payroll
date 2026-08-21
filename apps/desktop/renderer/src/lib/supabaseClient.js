/**
 * Supabase client for the RENDERER process only.
 *
 * This runs in the Chromium context, not Node — it must never see the
 * service role key. It uses the anon key + RLS, same as the main process
 * client, but scoped to the `mikaju` schema and with its own storage key so
 * a renderer session and a main-process session don't collide.
 *
 * Used for: Supabase Auth (sign up / sign in / sign out) and the
 * `license-issue` edge function invoke on first activation. Everyday data
 * reads/writes (employees, payroll runs) go through window.mikaju (preload
 * IPC bridge) → main process → local SQLite, NOT through this client
 * directly, to keep the offline-first contract intact.
 */
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.MIKAJU_DB_URL;
const anonKey = import.meta.env.MIKAJU_DB_ANON_KEY;

if (!url || !anonKey) {
  console.warn(
    '[Mikaju] MIKAJU_DB_URL / MIKAJU_DB_ANON_KEY not available to the renderer — ' +
    'check apps/desktop/.env and vite.config.js envPrefix.'
  );
}

export const supabase = createClient(url, anonKey, {
  db: { schema: 'mikaju' },
  auth: {
    persistSession: true,
    storageKey: 'mikaju-renderer-auth',
  },
});

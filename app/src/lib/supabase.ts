import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '@/config';

/**
 * The single Supabase client. Uses the publishable key; every read and write is checked by
 * row level security on the server (supabase/migrations). Sessions persist on the device.
 */
export const supabase: SupabaseClient = createClient(config.supabaseUrl || 'http://localhost', config.supabaseKey || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'cwc-auth' },
  realtime: { params: { eventsPerSecond: 5 } },
  global: { headers: { 'x-client-info': `cwc-app/${config.release}` } },
});

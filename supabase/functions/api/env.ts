/** Runtime configuration for the CWC API Edge Function. */
export interface Env {
  SUPABASE_URL: string;
  /** Service role key — provided automatically to Supabase Edge Functions. Never sent to browsers. */
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY?: string;
  /** Comma-separated origins allowed to call the API. */
  ALLOWED_ORIGINS?: string;
  PROFJERO_BASE_URL?: string;
  /** Optional override; otherwise read from the database (set by the developer in the app). */
  PROFJERO_API_KEY?: string;
  PROFJERO_SENDER_ID?: string;
  VAPID_SUBJECT?: string;
}

export const DEFAULT_ORIGINS = 'https://cwc-ch.pages.dev,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173';

export function envFromDeno(get: (k: string) => string | undefined): Env {
  let service = get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!service) {
    // Newer projects expose secret keys as JSON
    try {
      const keys = JSON.parse(get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>;
      service = keys.default ?? Object.values(keys)[0] ?? '';
    } catch {
      /* ignore */
    }
  }
  return {
    SUPABASE_URL: get('SUPABASE_URL') ?? '',
    SUPABASE_SERVICE_ROLE_KEY: service,
    SUPABASE_ANON_KEY: get('SUPABASE_ANON_KEY'),
    ALLOWED_ORIGINS: get('ALLOWED_ORIGINS'),
    PROFJERO_BASE_URL: get('PROFJERO_BASE_URL'),
    PROFJERO_API_KEY: get('PROFJERO_API_KEY'),
    PROFJERO_SENDER_ID: get('PROFJERO_SENDER_ID'),
    VAPID_SUBJECT: get('VAPID_SUBJECT'),
  };
}

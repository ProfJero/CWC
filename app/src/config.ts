const env = import.meta.env;

const supabaseUrl = ((env.VITE_SUPABASE_URL as string | undefined) ?? '').replace(/\/$/, '');

export const config = {
  supabaseUrl,
  /** Publishable (anon) key — safe in the browser; access is enforced by row level security. */
  supabaseKey: (env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? '',
  /** CWC API (Supabase Edge Function). Defaults to the project's `api` function. */
  apiUrl: ((env.VITE_API_URL as string | undefined) || (supabaseUrl ? `${supabaseUrl}/functions/v1/api` : '')).replace(/\/$/, ''),
  release: (env.VITE_RELEASE as string | undefined) ?? '2.0.0',
  isConfigured: Boolean(supabaseUrl && env.VITE_SUPABASE_PUBLISHABLE_KEY),
};

/** Defaults shown until the church profile is saved in Settings. */
export const CHURCH_DEFAULTS = {
  name: 'Christian Worship Centre',
  shortName: 'CWC',
  tagline: 'Worship • Word • World',
  currency: 'GHS',
  timezone: 'Africa/Accra',
  country: 'GH',
};

export const SIGNATURE = {
  name: 'ProfJero',
  tagline: 'Building Solutions. Empowering Lives.',
};

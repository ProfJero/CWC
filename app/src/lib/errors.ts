import { supabase } from './supabase';
import { config } from '@/config';

/**
 * Lightweight client error reporting for the developer console. Errors are de-duplicated on the
 * device and in the database (one row per error per day, with a counter), capped per session,
 * and never block the UI. Nothing is collected beyond the message, stack and page.
 */
const seen = new Set<string>();
let sent = 0;
const MAX_PER_SESSION = 15;

export function reportError(err: unknown, context?: string) {
  try {
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
    const message = `${context ? `[${context}] ` : ''}${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}`.slice(0, 500);
    if (!message || /ResizeObserver loop|Load failed|Failed to fetch|NetworkError|AbortError|ChunkLoadError/i.test(message)) return;
    const fp = message + (e.stack?.split('\n')[1] ?? '');
    if (seen.has(fp) || sent >= MAX_PER_SESSION || !config.isConfigured) return;
    seen.add(fp);
    sent++;
    void supabase.rpc('log_client_error', { p_message: message, p_stack: e.stack?.slice(0, 4000) ?? null, p_url: location.pathname, p_release: config.release }).then(() => {});
  } catch {
    /* never throw from the reporter */
  }
}

export function installErrorReporting() {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (ev) => reportError(ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason));
}

import { hex, HttpError } from './util.ts';
import type { Caller } from './auth.ts';

/** Which permission each upload folder needs (mirrors the old storage rules). */
const FOLDER_PERMS: Record<string, string | null> = {
  avatars: null, // anyone signed in: their own profile photo
  members: 'people.manage',
  events: 'events.manage',
  devotionals: 'content.manage',
  sermons: 'content.manage',
  announcements: 'content.manage',
  receipts: 'expenses.manage',
  branding: 'settings.manage',
};

export interface CloudinaryConfig {
  cloudName?: string;
  apiKey?: string;
  apiSecret?: string;
}

/** Signs an upload so the browser sends the file straight to Cloudinary (the API secret never leaves the server). */
export async function signUpload(cfg: CloudinaryConfig, caller: Caller, folder: string, now = Date.now()) {
  if (!cfg.cloudName || !cfg.apiKey || !cfg.apiSecret) throw new HttpError(503, 'Cloudinary is not configured yet', 'not_configured');
  if (!(folder in FOLDER_PERMS)) throw new HttpError(400, 'Unknown folder');
  const need = FOLDER_PERMS[folder];
  if (need && !caller.permissions.includes(need)) throw new HttpError(403, 'Your role cannot upload here');
  const timestamp = Math.floor(now / 1000);
  const fullFolder = folder === 'avatars' ? `cwc/avatars/${caller.uid}` : `cwc/${folder}`;
  const toSign = `folder=${fullFolder}&timestamp=${timestamp}${cfg.apiSecret}`;
  const signature = hex(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(toSign)));
  return { signature, timestamp, apiKey: cfg.apiKey, cloudName: cfg.cloudName, folder: fullFolder };
}

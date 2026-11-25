import { supabase } from './supabase';
import { api, ApiError } from './api';
import { config } from '@/config';

export type UploadFolder = 'avatars' | 'members' | 'events' | 'devotionals' | 'sermons' | 'announcements' | 'receipts' | 'branding';

/**
 * Media goes to Cloudinary (signed by the server — the API secret never reaches the browser).
 * Until a developer enters the Cloudinary keys (Developer → Integrations), uploads fall back to
 * Supabase Storage so nothing breaks. Expense receipts always stay in the private "receipts" bucket.
 */
export function cloudinaryConfigured() {
  return config.isConfigured;
}
export const mediaConfigured = cloudinaryConfigured;

/** Shrinks big phone photos before upload — saves members' data bundles and storage space. */
async function downscale(file: File, max = 1600): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1.2e6) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((res) => canvas.toBlob((b) => res(b ?? file), 'image/webp', 0.84));
  } catch {
    return file;
  }
}

const EXT: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'application/pdf': 'pdf', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };

interface Signature {
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  folder: string;
}

function xhrUpload(url: string, body: FormData | Blob, headers: Record<string, string>, onProgress?: (pct: number) => void) {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.responseText) : reject(Object.assign(new Error(xhr.responseText || `Upload failed (${xhr.status})`), { status: xhr.status })));
    xhr.onerror = () => reject(new Error('Upload failed — check your connection.'));
    xhr.send(body);
  });
}

async function uploadToCloudinaryDirect(file: File, folder: UploadFolder, onProgress?: (pct: number) => void): Promise<string | null> {
  let sig: Signature;
  try {
    sig = await api<Signature>('/v1/media/sign', { method: 'POST', json: { folder } });
  } catch (e) {
    if (e instanceof ApiError && e.code === 'not_configured') return null; // fall back to Supabase Storage
    throw e;
  }
  const isImage = file.type.startsWith('image/');
  const resource = isImage ? 'image' : file.type.startsWith('audio/') || file.type.startsWith('video/') ? 'video' : 'raw';
  const form = new FormData();
  form.append('file', isImage ? await downscale(file) : file);
  form.append('api_key', sig.apiKey);
  form.append('timestamp', String(sig.timestamp));
  form.append('signature', sig.signature);
  form.append('folder', sig.folder);
  try {
    const text = await xhrUpload(`https://api.cloudinary.com/v1_1/${sig.cloudName}/${resource}/upload`, form, {}, onProgress);
    const res = JSON.parse(text) as { secure_url?: string };
    if (!res.secure_url) throw new Error('Upload failed');
    return res.secure_url;
  } catch (e) {
    let msg = 'Upload failed';
    try {
      msg = (JSON.parse((e as Error).message) as { error?: { message?: string } }).error?.message || msg;
    } catch {
      msg = (e as Error).message.startsWith('Upload failed') ? (e as Error).message : msg;
    }
    throw new Error(msg);
  }
}

/**
 * Uploads a file and returns its URL. Receipts return a "receipts:<path>" reference that is
 * turned into a short-lived link with `signedUrl()` (they are private).
 */
export async function uploadMedia(file: File, folder: UploadFolder, onProgress?: (pct: number) => void): Promise<string> {
  if (folder !== 'receipts') {
    const url = await uploadToCloudinaryDirect(file, folder, onProgress);
    if (url) return url;
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const uid = data.session?.user.id;
  if (!token || !uid) throw new Error('Please sign in to upload files.');
  const body = file.type.startsWith('image/') ? await downscale(file) : file;
  const type = body.type || file.type || 'application/octet-stream';
  const ext = EXT[type] ?? (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const bucket = folder === 'receipts' ? 'receipts' : 'media';
  const name = `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}.${ext}`;
  const path = folder === 'avatars' ? `avatars/${uid}/${name}` : `${folder}/${name}`;

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${config.supabaseUrl}/storage/v1/object/${bucket}/${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', config.supabaseKey);
    xhr.setRequestHeader('Content-Type', type);
    xhr.setRequestHeader('cache-control', 'max-age=31536000');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = 'Upload failed';
      try {
        const r = JSON.parse(xhr.responseText) as { message?: string; error?: string };
        msg = r.message || r.error || msg;
      } catch {
        /* ignore */
      }
      if (/row-level security|unauthorized|403/i.test(msg)) msg = 'You don’t have permission to upload here.';
      if (/size|too large|413/i.test(msg) || xhr.status === 413) msg = 'That file is too large.';
      if (/mime|type/i.test(msg)) msg = 'That file type isn’t supported.';
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('Upload failed — check your connection.'));
    xhr.send(body);
  });
  if (bucket === 'receipts') return `receipts:${path}`;
  return `${config.supabaseUrl}/storage/v1/object/public/media/${path}`;
}

/** Back-compat name used across the app. */
export const uploadToCloudinary = uploadMedia;

/** Turns a private "receipts:<path>" reference into a link valid for 10 minutes. */
export async function signedUrl(ref: string | undefined | null): Promise<string | null> {
  if (!ref) return null;
  if (!ref.startsWith('receipts:')) return ref;
  const { data, error } = await supabase.storage.from('receipts').createSignedUrl(ref.slice('receipts:'.length), 600);
  if (error) return null;
  return data.signedUrl;
}

/** Image URL helper (kept for older Cloudinary URLs; Supabase URLs pass through). */
export function cld(url: string | undefined | null, opts: { w?: number; h?: number; fill?: boolean } = {}) {
  if (!url) return undefined;
  if (!url.includes('res.cloudinary.com') || !url.includes('/upload/')) return url;
  const t = ['f_auto', 'q_auto'];
  if (opts.w) t.push(`w_${opts.w}`);
  if (opts.h) t.push(`h_${opts.h}`);
  if (opts.fill) t.push('c_fill', 'g_auto');
  else if (opts.w || opts.h) t.push('c_limit');
  return url.replace('/upload/', `/upload/${t.join(',')}/`);
}

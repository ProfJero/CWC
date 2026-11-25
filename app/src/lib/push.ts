import { api, apiConfigured } from './api';
import { supabase } from './supabase';

export type PushState = 'unsupported' | 'denied' | 'default' | 'subscribed' | 'unsubscribed';

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** iOS only allows web push for apps added to the Home Screen. */
export function needsInstallForPush() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return ios && !isStandalone();
}

export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

function b64urlToBytes(s: string) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) return 'subscribed';
  return Notification.permission === 'granted' ? 'unsubscribed' : 'default';
}

/** Works for visitors without an account too (church-wide notifications). */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (!apiConfigured()) throw new Error('Notifications are not configured.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'default';
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api<{ publicKey: string }>('/v1/push/public-key');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
  }
  await saveSubscription(sub);
  return 'subscribed';
}

/** Stores (or re-links to the signed-in account) this device's push subscription. */
export async function saveSubscription(sub: PushSubscription) {
  const json = sub.toJSON();
  const { error } = await supabase.rpc('subscribe_push', {
    p_endpoint: sub.endpoint,
    p_p256dh: json.keys?.p256dh ?? '',
    p_auth: json.keys?.auth ?? '',
    p_user_agent: navigator.userAgent.slice(0, 200),
  });
  if (error) throw new Error(error.message);
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await supabase.rpc('unsubscribe_push', { p_endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  return 'unsubscribed';
}

/** Keep the stored subscription fresh (endpoints rotate) and attached to whoever is signed in. */
export async function refreshPushSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await saveSubscription(sub).catch(() => {});
}

/** Sends a test notification to this account's devices. */
export function sendTestPush() {
  return api<{ devices: number; delivered: number }>('/v1/push/test', { method: 'POST', json: {} });
}

export interface NotifyInput {
  title: string;
  body: string;
  url?: string;
  imageUrl?: string;
  kind?: 'announcement' | 'devotional' | 'event' | 'sermon' | 'general' | 'care';
  /** 'all' (default) or a single person's uid */
  to?: 'all' | { uid: string };
  push?: boolean;
}

/**
 * Posts an in-app notification. Push delivery to every device is done by the server
 * (database trigger → Edge Function), so the sender's phone doesn't do the work.
 */
export async function notify(input: NotifyInput) {
  const to = input.to ?? 'all';
  const { error } = await supabase.from('notifications').insert({
    title: input.title.slice(0, 140),
    body: input.body.slice(0, 1000),
    url: input.url && input.url.startsWith('/') ? input.url : null,
    image_url: input.imageUrl ?? null,
    kind: input.kind ?? 'general',
    audience: to === 'all' ? 'all' : 'user',
    target_uid: to === 'all' ? null : to.uid,
    send_push: input.push !== false,
  });
  if (error) throw new Error(error.message);
}

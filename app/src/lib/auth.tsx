import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthError } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { clearAllCaches, flushOutbox, fromRow, invalidate, rpc, setActor, setCacheScope } from './db';
import { api, ApiError } from './api';
import { hasPermission, type Permission } from './permissions';
import { normalizePhone, isValidPhone } from './phone';
import type { Role, RoleDef, UserProfile } from './types';

/**
 * Members may use the app with just a phone number. Those accounts sign in with a synthetic
 * login email derived from the number; it is never shown or emailed.
 */
export const PHONE_LOGIN_DOMAIN = 'phone.cwc.app';

export function loginEmailFor(identifier: string) {
  const v = identifier.trim();
  if (v.includes('@')) return v.toLowerCase();
  if (isValidPhone(v)) return `${normalizePhone(v)}@${PHONE_LOGIN_DOMAIN}`;
  return v.toLowerCase();
}

export function isPhoneLogin(email?: string | null) {
  return !!email && email.endsWith('@' + PHONE_LOGIN_DOMAIN);
}

export interface AuthUser {
  uid: string;
  email: string | null;
}

interface AuthState {
  user: AuthUser | null;
  profile: UserProfile | null;
  role: Role | null;
  permissions: string[];
  loading: boolean;
  /** Any role with at least one permission sees the staff area. */
  staff: boolean;
  /** A device account: the person hasn't chosen a password yet. */
  guest: boolean;
  /** Signed in and has a church member record (profile completed). */
  hasProfile: boolean;
  can: (p: Permission) => boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  profile: null,
  role: null,
  permissions: [],
  loading: true,
  staff: false,
  guest: false,
  hasProfile: false,
  can: () => false,
  refresh: async () => {},
});

async function loadProfile(uid: string): Promise<UserProfile | null> {
  const { data, error } = await supabase.from('users').select('*, uid:id, roleDef:roles(*)').eq('id', uid).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const p = fromRow<UserProfile>(data as Record<string, unknown>);
  p.roleDef = p.roleDef ? fromRow<RoleDef>(p.roleDef as unknown as Record<string, unknown>) : null;
  return p;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  async function hydrate(uid: string | null, email: string | null) {
    if (!uid) {
      setUser(null);
      setProfile(null);
      setActor(null);
      setCacheScope(null);
      setLoading(false);
      return;
    }
    setUser({ uid, email });
    setCacheScope(uid);
    // The profile row is created by a database trigger; retry briefly right after sign-up.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const p = await loadProfile(uid);
        if (p || attempt === 3) {
          setProfile(p);
          setActor(p ? { uid, name: p.fullName || 'User' } : null);
          break;
        }
      } catch (e) {
        if (!navigator.onLine) break;
        if (attempt === 3) console.error('[cwc] profile load failed', e);
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
    setLoading(false);
    void flushOutbox();
  }

  useEffect(() => {
    let current: string | null | undefined;
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const uid = session?.user.id ?? null;
      if (event === 'TOKEN_REFRESHED' && uid === current) return;
      if (event === 'USER_UPDATED' && uid === current) return;
      current = uid;
      setLoading(true);
      // Defer: avoid calling Supabase inside the auth callback (documented deadlock).
      setTimeout(() => void hydrate(uid, session?.user.email ?? null), 0);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthState>(() => {
    const active = profile?.isActive !== false;
    const role = active ? profile?.role ?? null : null;
    const permissions = active ? profile?.roleDef?.permissions ?? [] : [];
    return {
      user,
      profile,
      role,
      permissions,
      loading,
      staff: permissions.length > 0,
      guest: !!profile?.isGuest,
      hasProfile: !!profile?.memberId,
      can: (p) => hasPermission(permissions, p),
      refresh: async () => {
        if (user) {
          const p = await loadProfile(user.uid);
          setProfile(p);
          if (p) setActor({ uid: user.uid, name: p.fullName || 'User' });
          invalidate('members', 'users');
        }
      },
    };
  }, [user, profile, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

export async function signIn(identifier: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email: loginEmailFor(identifier), password });
  if (error) throw error;
  void supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', data.user.id).then(() => {});
  return data.user;
}

export interface SignUpInput {
  fullName: string;
  phone: string;
  email?: string;
  password: string;
}

/** Creates an account (no email confirmation needed) and signs in. */
export async function signUp(input: SignUpInput) {
  await api('/v1/auth/register', { method: 'POST', json: { fullName: input.fullName.trim(), phone: input.phone, email: input.email?.trim() || undefined, password: input.password } });
  return signIn(input.email?.trim() || input.phone, input.password);
}

const DEVICE_SECRET = 'cwc-device-secret';

function randomSecret() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, '').slice(0, 32);
}

export interface ProfileInput {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  gender?: 'male' | 'female' | '';
  dob?: string;
  membershipStatus?: 'visitor' | 'first_timer' | 'member' | 'new_convert';
  address?: string;
  occupation?: string;
  howHeard?: string;
  invitedBy?: string;
}

/**
 * "Complete your profile" — the only step a member needs. If the person has no account yet,
 * a private device account is created behind the scenes (no password to remember). They can
 * add a password later from their profile to sign in on other devices.
 */
export async function completeProfile(input: ProfileInput, opts: { signedIn: boolean }) {
  const fullName = `${input.firstName.trim()} ${input.lastName.trim()}`;
  if (!opts.signedIn) {
    const secret = randomSecret();
    try {
      await api('/v1/auth/register', { method: 'POST', json: { fullName, phone: input.phone, password: secret, guest: true } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        throw new ApiError(409, 'This phone number already has an account. Sign in to continue — or ask the church office to reset it.', 'exists');
      }
      throw e;
    }
    try {
      localStorage.setItem(DEVICE_SECRET, secret);
    } catch {
      /* private mode: the session still persists for now */
    }
    await signIn(input.phone, secret);
  }
  const memberId = await rpc<string>('complete_profile', { p: { ...input, phone: normalizePhone(input.phone) } }, ['members', 'users']);
  return memberId;
}

/** Turns a device account into a normal one by choosing a password (and optionally an email). */
export async function secureAccount(password: string) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
  const { data } = await supabase.auth.getUser();
  if (data.user) await supabase.from('users').update({ is_guest: false, must_change_password: false }).eq('id', data.user.id);
  try {
    localStorage.removeItem(DEVICE_SECRET);
  } catch {
    /* ignore */
  }
}

export async function changePassword(currentIdentifier: string, current: string, next: string) {
  const { error: e1 } = await supabase.auth.signInWithPassword({ email: currentIdentifier, password: current });
  if (e1) throw e1;
  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) throw error;
  const { data } = await supabase.auth.getUser();
  if (data.user) await supabase.from('users').update({ must_change_password: false }).eq('id', data.user.id);
}

export async function resetPassword(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: `${location.origin}/reset-password` });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
  clearAllCaches();
  try {
    sessionStorage.clear();
    localStorage.removeItem(DEVICE_SECRET);
  } catch {
    /* ignore */
  }
}

export function authErrorMessage(err: unknown): string {
  const e = err as AuthError & { code?: string; status?: number };
  const code = e?.code ?? '';
  const msg = e?.message ?? '';
  if (err instanceof ApiError) return err.message;
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'That email/phone and password don’t match. Please try again.';
  if (code === 'email_not_confirmed') return 'Please confirm your email first (check your inbox), or ask the church office for help.';
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || e?.status === 429) return 'Too many attempts. Please wait a moment and try again.';
  if (code === 'weak_password') return 'Choose a stronger password (at least 8 characters).';
  if (code === 'same_password') return 'Choose a password different from your current one.';
  if (code === 'user_banned') return 'This account has been disabled. Please contact the church office.';
  if (/fetch|network/i.test(msg)) return 'You appear to be offline. Check your connection and retry.';
  return msg || 'Something went wrong. Please try again.';
}

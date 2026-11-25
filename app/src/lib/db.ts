import { useSyncExternalStore } from 'react';
import type { PostgrestError, RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

/* ------------------------------------------------------------------ */
/* Row mapping: the database uses snake_case, the app camelCase.       */
/* ------------------------------------------------------------------ */

const toCamelKey = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const toSnakeKey = (k: string) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

export function fromRow<T>(row: Record<string, unknown> | null | undefined): T {
  if (!row) return row as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[toCamelKey(k)] = v;
  return out as T;
}

/** Empty strings become NULL for typed (date / uuid / number) columns. */
const NULL_IF_EMPTY = new Set([
  'dob', 'anniversary', 'joinDate', 'baptismDate', 'salvationDate', 'date', 'dueDate', 'startDate', 'endDate', 'expiresOn',
  'preferredDate', 'memberId', 'householdId', 'assignedTo', 'serviceId', 'pledgeId', 'campaignId', 'uid', 'targetUid', 'capacity',
]);
const SERVER_MANAGED = new Set(['createdAt', 'updatedAt', 'birthMonthDay']);

export function toRow(data: Record<string, unknown>, keepId = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || SERVER_MANAGED.has(k) || (k === 'id' && !keepId)) continue;
    out[toSnakeKey(k)] = v === '' && NULL_IF_EMPTY.has(k) ? null : v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class DbError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

export function friendlyDbError(e: PostgrestError | { message?: string; code?: string } | null): DbError {
  const code = e?.code ?? '';
  const msg = e?.message ?? '';
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return new DbError('You appear to be offline. Check your connection and retry.', 'network');
  if (code === '42501' || /row-level security|permission denied/i.test(msg)) {
    // Our own database checks raise friendly sentences — keep those.
    if (msg && !/row-level security|permission denied/i.test(msg)) return new DbError(msg, code);
    return new DbError('You don’t have permission to do that.', code);
  }
  if (code === '23505') return new DbError('This already exists.', code);
  if (code === '23503') return new DbError(msg.includes('Move the people') ? msg : 'This is linked to other records and can’t be changed that way.', code);
  if (code === '23514' || code === '22P02' || code === '22007' || code === '22008') return new DbError('Some details look invalid. Please check and try again.', code);
  return new DbError(msg || 'Something went wrong. Please try again.', code);
}

/* ------------------------------------------------------------------ */
/* Shared, cached queries                                              */
/* One fetch per key, shared by every component using it. Data is      */
/* refreshed when stale (on mount, focus, reconnect or after a write)  */
/* — nothing polls. Realtime is opt-in for the few live screens.       */
/* ------------------------------------------------------------------ */

export interface LiveState<T> {
  data: T;
  loading: boolean;
  error: Error | null;
}

type Result = { data: unknown; error: PostgrestError | null };
type Builder = PromiseLike<Result>;

interface Entry {
  key: string;
  tables: string[];
  state: LiveState<unknown>;
  listeners: Set<() => void>;
  build: () => Builder;
  single: boolean;
  fetchedAt: number;
  inflight?: Promise<void>;
  live?: { table: string; filter?: string };
  channel?: RealtimeChannel;
  closeTimer?: ReturnType<typeof setTimeout>;
}

const STALE_MS = 30_000;
const KEEP_LIVE_MS = 20_000;
const registry = new Map<string, Entry>();
let cacheScope = 'anon';

const storageKey = (key: string) => `cwc:q:${cacheScope}:${key}`;

function readCache(key: string): unknown {
  try {
    const raw = localStorage.getItem(storageKey(key));
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(key: string, data: unknown) {
  try {
    const s = JSON.stringify(data);
    if (s.length < 400_000) localStorage.setItem(storageKey(key), s);
  } catch {
    /* storage full or unavailable */
  }
}

/** Separates cached data per account; call on sign-in/out. */
export function setCacheScope(scope: string | null) {
  const next = scope ?? 'anon';
  if (next === cacheScope) return;
  cacheScope = next;
  for (const e of registry.values()) {
    e.channel?.unsubscribe();
  }
  registry.clear();
  subscribers.clear();
}

export function clearAllCaches() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith('cwc:q:')) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
  setCacheScope('anon');
  registry.clear();
}

function emit(e: Entry) {
  e.listeners.forEach((l) => l());
}

async function run(e: Entry) {
  if (e.inflight) return e.inflight;
  e.inflight = (async () => {
    try {
      const { data, error } = await e.build();
      if (error) throw friendlyDbError(error);
      const mapped = e.single ? (data ? fromRow(data as Record<string, unknown>) : null) : ((data as Record<string, unknown>[]) ?? []).map((r) => fromRow(r));
      e.state = { data: mapped, loading: false, error: null };
      e.fetchedAt = Date.now();
      writeCache(e.key, mapped);
    } catch (err) {
      const offline = typeof navigator !== 'undefined' && !navigator.onLine;
      // Keep showing cached data when offline; surface the error otherwise.
      e.state = { ...e.state, loading: false, error: offline && e.state.data ? null : (err as Error) };
      if (!offline) console.warn('[cwc] query failed', e.key, err);
    } finally {
      e.inflight = undefined;
      emit(e);
    }
  })();
  return e.inflight;
}

function openLive(e: Entry) {
  if (!e.live || e.channel) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  e.channel = supabase
    .channel(`rt:${e.key}:${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: e.live.table, ...(e.live.filter ? { filter: e.live.filter } : {}) }, () => {
      clearTimeout(t);
      t = setTimeout(() => void run(e), 250);
    })
    .subscribe();
}

function getEntry(key: string, tables: string[], build: () => Builder, single: boolean, live?: Entry['live']) {
  let e = registry.get(key);
  if (!e) {
    const cached = readCache(key);
    e = {
      key,
      tables,
      build,
      single,
      live,
      fetchedAt: 0,
      listeners: new Set(),
      state: cached !== undefined ? { data: cached, loading: false, error: null } : { data: single ? null : [], loading: true, error: null },
    };
    registry.set(key, e);
  } else {
    e.build = build;
  }
  return e;
}

const subscribers = new Map<string, (l: () => void) => () => void>();

function subscriberFor(e: Entry) {
  let s = subscribers.get(e.key);
  if (!s) {
    s = (listener: () => void) => {
      const entry = registry.get(e.key) ?? e;
      clearTimeout(entry.closeTimer);
      entry.listeners.add(listener);
      if (Date.now() - entry.fetchedAt > STALE_MS) void run(entry);
      openLive(entry);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0 && entry.channel) {
          entry.closeTimer = setTimeout(() => {
            entry.channel?.unsubscribe();
            entry.channel = undefined;
          }, KEEP_LIVE_MS);
        }
      };
    };
    subscribers.set(e.key, s);
  }
  return s;
}

const EMPTY: LiveState<never[]> = { data: [], loading: false, error: null };
const NULL_DOC: LiveState<null> = { data: null, loading: false, error: null };
const noop = () => () => {};

export interface QueryOptions {
  /** Extra tables whose writes should refresh this query. */
  alsoTables?: string[];
  /** Subscribe to realtime changes while the screen is open (use sparingly). */
  live?: boolean | { filter?: string };
}

/** Cached list query. Pass key = null to skip. */
export function useCollection<T>(key: string | null, table: string, build: () => Builder, opts: QueryOptions = {}): LiveState<T[]> {
  const live = opts.live ? { table, filter: typeof opts.live === 'object' ? opts.live.filter : undefined } : undefined;
  const e = key ? getEntry(key, [table, ...(opts.alsoTables ?? [])], build, false, live) : null;
  const sub = e ? subscriberFor(e) : noop;
  return useSyncExternalStore(sub, () => (e ? (registry.get(e.key)?.state as LiveState<T[]>) ?? EMPTY : EMPTY));
}

/** Cached single row by "table/id". */
export function useDocument<T>(path: string | null, opts: QueryOptions = {}): LiveState<T | null> {
  const [table, id] = path ? splitPath(path) : ['', ''];
  const key = path ? `doc:${path}` : null;
  const live = opts.live ? { table, filter: `id=eq.${id}` } : undefined;
  const e = key ? getEntry(key, [table, ...(opts.alsoTables ?? [])], () => supabase.from(table).select('*').eq('id', id).maybeSingle(), true, live) : null;
  const sub = e ? subscriberFor(e) : noop;
  return useSyncExternalStore(sub, () => (e ? (registry.get(e.key)?.state as LiveState<T | null>) ?? NULL_DOC : NULL_DOC));
}

/** Cached single row from any query. */
export function useSingle<T>(key: string | null, table: string, build: () => Builder, opts: QueryOptions = {}): LiveState<T | null> {
  const live = opts.live ? { table, filter: typeof opts.live === 'object' ? opts.live.filter : undefined } : undefined;
  const e = key ? getEntry(key, [table, ...(opts.alsoTables ?? [])], build, true, live) : null;
  const sub = e ? subscriberFor(e) : noop;
  return useSyncExternalStore(sub, () => (e ? (registry.get(e.key)?.state as LiveState<T | null>) ?? NULL_DOC : NULL_DOC));
}

function splitPath(path: string): [string, string] {
  const i = path.indexOf('/');
  return [path.slice(0, i), path.slice(i + 1)];
}

/** Refreshes every open query that reads one of these tables (and drops stale closed ones). */
export function invalidate(...tables: string[]) {
  for (const e of registry.values()) {
    if (!e.tables.some((t) => tables.includes(t))) continue;
    e.fetchedAt = 0;
    if (e.listeners.size) void run(e);
  }
}

/** Refresh stale open queries when the app regains focus or connectivity. */
function revalidateOpen() {
  for (const e of registry.values()) {
    if (e.listeners.size && Date.now() - e.fetchedAt > STALE_MS) void run(e);
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('focus', revalidateOpen);
  window.addEventListener('online', () => {
    revalidateOpen();
    void flushOutbox();
  });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && revalidateOpen());
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export interface Actor {
  uid: string;
  name: string;
}

let actor: Actor | null = null;
export function setActor(a: Actor | null) {
  actor = a;
}
export function getActor() {
  return actor;
}

type Data = Record<string, unknown>;

/** Tables whose counters/derived data change when another table changes (via triggers). */
const DEPENDENTS: Record<string, string[]> = {
  rsvps: ['events'],
  attendance: ['services'],
  gifts: ['pledges'],
  members: ['groups', 'users', 'followups'],
  care_requests: ['notifications'],
  users: ['members'],
};
const touch = (table: string) => invalidate(table, ...(DEPENDENTS[table] ?? []));

export async function createDoc(table: string, data: Data, opts: { id?: string; audit?: string } = {}) {
  const row = toRow(opts.id ? { ...data, id: opts.id } : data, Boolean(opts.id));
  const { data: res, error } = await supabase.from(table).insert(row).select('id').single();
  if (error) throw friendlyDbError(error);
  const id = String((res as { id: string }).id);
  touch(table);
  if (opts.audit) void audit('create', table, id, opts.audit);
  return id;
}

/** Insert without reading the row back (for tables the writer may not be allowed to read). */
export async function insertOnly(table: string, data: Data | Data[]) {
  const rows = Array.isArray(data) ? data.map((d) => toRow(d)) : toRow(data);
  const { error } = await supabase.from(table).insert(rows);
  if (error) throw friendlyDbError(error);
  touch(table);
}

export async function patchDoc(table: string, id: string, data: Data, opts: { audit?: string } = {}) {
  const { data: rows, error } = await supabase.from(table).update(toRow(data)).eq('id', id).select('id');
  if (error) throw friendlyDbError(error);
  if (!rows?.length) throw new DbError('You don’t have permission to change this, or it no longer exists.', 'not_found');
  touch(table);
  if (opts.audit) void audit('update', table, id, opts.audit);
}

/** Update many rows matching ids. */
export async function patchMany(table: string, ids: string[], data: Data) {
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await supabase.from(table).update(toRow(data)).in('id', ids.slice(i, i + 200));
    if (error) throw friendlyDbError(error);
  }
  touch(table);
}

export async function removeDoc(table: string, id: string, opts: { audit?: string } = {}) {
  const { error, count } = await supabase.from(table).delete({ count: 'exact' }).eq('id', id);
  if (error) throw friendlyDbError(error);
  if (count === 0) throw new DbError('You don’t have permission to delete this, or it no longer exists.', 'not_found');
  touch(table);
  if (opts.audit) void audit('delete', table, id, opts.audit);
}

/** Bulk insert in chunks (one request per 500 rows; each chunk is atomic). */
export async function createMany(table: string, rows: Data[], onProgress?: (done: number) => void) {
  let done = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => toRow(r));
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw friendlyDbError(error);
    done += chunk.length;
    onProgress?.(done);
  }
  touch(table);
}

/** Calls a database function (RPC). */
export async function rpc<T = unknown>(fn: string, args: Data = {}, refresh: string[] = []): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw friendlyDbError(error);
  if (refresh.length) refresh.forEach(touch);
  return data as T;
}

export async function audit(action: string, entity: string, entityId: string | undefined, summary: string) {
  if (!actor) return;
  const { error } = await supabase.from('audit_logs').insert({ action, entity, entity_id: entityId ?? null, summary, by_name: actor.name });
  if (error) console.warn('[cwc] audit failed', error.message);
  else invalidate('audit_logs');
}

/* ------------------------------------------------------------------ */
/* Offline outbox — requests made without a connection are sent later */
/* ------------------------------------------------------------------ */

const OUTBOX = 'cwc-outbox';
interface Pending {
  table: string;
  data: Data;
  at: number;
}

function readOutbox(): Pending[] {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX) || '[]') as Pending[];
  } catch {
    return [];
  }
}

export function pendingCount() {
  return readOutbox().length;
}

/** Inserts now, or queues the row on this device and sends it when back online. Returns true if queued. */
export async function createOrQueue(table: string, data: Data): Promise<boolean> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    localStorage.setItem(OUTBOX, JSON.stringify([...readOutbox(), { table, data, at: Date.now() }]));
    return true;
  }
  try {
    await insertOnly(table, data);
    return false;
  } catch (e) {
    if ((e as DbError).code === 'network') {
      localStorage.setItem(OUTBOX, JSON.stringify([...readOutbox(), { table, data, at: Date.now() }]));
      return true;
    }
    throw e;
  }
}

let flushing = false;
export async function flushOutbox() {
  if (flushing || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
  const items = readOutbox();
  if (!items.length) return;
  flushing = true;
  const left: Pending[] = [];
  for (const it of items) {
    try {
      await insertOnly(it.table, it.data);
    } catch (e) {
      if ((e as DbError).code === 'network') left.push(it);
      else console.warn('[cwc] dropped queued item', e);
    }
  }
  localStorage.setItem(OUTBOX, JSON.stringify(left));
  flushing = false;
}

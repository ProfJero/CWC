import { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, Bug, CheckCircle2, Clock, Cpu, Database, HardDrive, KeyRound, Play, RefreshCw, Server, ShieldCheck, Trash2, Users, Wrench, XCircle, Zap, Pause } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { api } from '@/lib/api';
import { rpc } from '@/lib/db';
import { config } from '@/config';
import { fmtDateTime, num, relative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Page, PageHeader } from '@/components/ui/page';
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Banner, EmptyState } from '@/components/ui/feedback';
import { TextField, Switch } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useConfirm } from '@/components/ui/confirm';

interface Health {
  generatedAt: string;
  db: { sizeBytes: number; limitBytes: number; connections: number; maxConnections: number; cacheHitRatio: number | null; version: string; uptimeSeconds: number };
  tables: { name: string; rows: number; dead: number; sizeBytes: number }[];
  auth: { users: number; signups7d: number; active7d: number; active30d: number; mauLimit: number };
  app: { members: number; unverifiedMembers: number; guestAccounts: number; staff: number; inactiveAccounts: number; pushSubscriptions: number; notifications7d: number; openCare: number };
  roles: { role: string; label: string; count: number }[];
  errors: { today: number; last7d: number; top: { id: number; message: string; url?: string; count: number; lastAt: string; release?: string; stack?: string }[] };
  jobs: { job: string; startedAt: string; finishedAt?: string; ok?: boolean; detail?: Record<string, unknown> }[];
  integrations: { pushDispatch: boolean; vapid: boolean; smsKey: boolean; cron: boolean };
  storage?: { objects: number; bytes: number; limitBytes: number };
  cron?: { job: string; schedule: string; lastStatus?: string; lastRun?: string; message?: string }[];
}

interface Diagnostics {
  version: string;
  region: string | null;
  dbRoundTripMs: number;
  vapid: boolean;
  sms: { configured: boolean; ok?: boolean; status?: number; ms?: number; balance?: unknown; error?: string };
  at: string;
}

const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function Meter({ label, used, limit, fmt = (n: number) => num(n), icon }: { label: string; used: number; limit: number; fmt?: (n: number) => string; icon: React.ReactNode }) {
  const pct = limit ? Math.min(1, used / limit) : 0;
  const tone = pct > 0.85 ? 'bg-danger' : pct > 0.6 ? 'bg-warning' : 'bg-success';
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2 text-[13px] font-medium text-fg-3">
        <span className="flex items-center gap-2 [&_svg]:size-4">{icon}{label}</span>
        <span className="tabular">{(pct * 100).toFixed(pct < 0.1 ? 1 : 0)}%</span>
      </div>
      <p className="mt-2 text-lg font-semibold tabular">{fmt(used)} <span className="text-sm font-normal text-fg-3">/ {fmt(limit)}</span></p>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={cn('h-full rounded-full transition-[width]', tone)} style={{ width: `${Math.max(2, pct * 100)}%` }} />
      </div>
    </div>
  );
}

function Check({ ok, label, detail }: { ok: boolean | undefined; label: string; detail?: string }) {
  return (
    <li className="flex items-center gap-3 px-5 py-3">
      {ok === undefined ? <Clock className="size-4 text-fg-3" /> : ok ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className="size-4 text-danger" />}
      <span className="flex-1 text-sm">{label}</span>
      {detail && <span className="text-right text-xs text-fg-3">{detail}</span>}
    </li>
  );
}

/**
 * Developer console — on-demand monitoring. Nothing here runs in the background: data is fetched
 * when the page is opened or Refresh is pressed (optional auto-refresh stops when you leave or
 * hide the tab), so monitoring never eats into database or function quotas.
 */
export default function Developer() {
  const confirm = useConfirm();
  const [health, setHealth] = useState<Health | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [auto, setAuto] = useState(false);
  const [smsKey, setSmsKey] = useState('');
  const [openStack, setOpenStack] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  async function load(withDiag = false) {
    setBusy(true);
    setError('');
    try {
      const h = await rpc<Health>('dev_system_health');
      setHealth(h);
      if (withDiag) setDiag(await api<Diagnostics>('/v1/dev/diagnostics'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load(true);
  }, []);

  // Optional auto-refresh while the tab is visible (every 60 s); off by default.
  useEffect(() => {
    clearInterval(timer.current);
    if (!auto) return;
    timer.current = setInterval(() => document.visibilityState === 'visible' && void load(false), 60_000);
    return () => clearInterval(timer.current);
  }, [auto]);

  async function maintenance(action: 'cleanup' | 'clear_errors' | 'analyze', label: string) {
    if (action === 'clear_errors' && !(await confirm({ title: 'Clear the error log?', description: 'Removes every recorded client error.', confirmLabel: 'Clear', danger: true }))) return;
    try {
      const r = await rpc<Record<string, number | boolean>>('dev_maintenance', { p_action: action });
      toast.success(label, { description: Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' · ') });
      void load(false);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function runDaily() {
    if (!(await confirm({ title: 'Run the daily job now?', description: 'Sends today’s birthday SMS (if enabled) and tomorrow’s event reminders. Safe to repeat — SMS sends are de-duplicated per day.', confirmLabel: 'Run now' }))) return;
    try {
      const r = await api<Record<string, unknown>>('/v1/dev/run-job', { method: 'POST', json: { job: 'daily' } });
      toast.success('Daily job finished', { description: JSON.stringify(r).slice(0, 180) });
      void load(false);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function saveSmsKey() {
    try {
      await rpc('set_integration_secret', { p_key: 'profjero_api_key', p_value: smsKey });
      setSmsKey('');
      toast.success(smsKey ? 'SMS key saved securely' : 'SMS key removed');
      void load(true);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const ownTables = health?.tables ?? [];
  const pushOk = health?.integrations.pushDispatch && health.integrations.vapid;

  return (
    <Page width="wide">
      <PageHeader
        eyebrow="Platform"
        title="Developer console"
        description="System health, errors and maintenance — loaded only when you look."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant={auto ? 'soft' : 'outline'} icon={auto ? <Pause /> : <Activity />} onClick={() => setAuto((a) => !a)}>{auto ? 'Auto: on' : 'Auto-refresh'}</Button>
            <Button size="sm" icon={<RefreshCw className={busy ? 'animate-spin' : ''} />} onClick={() => load(true)} disabled={busy}>Refresh</Button>
          </div>
        }
      />
      {error && <Banner tone="danger" className="mb-4">{error}</Banner>}
      {health && <p className="mb-4 text-xs text-fg-3">Snapshot {relative(health.generatedAt)} · {fmtDateTime(health.generatedAt)} · Postgres {health.db.version}</p>}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="errors" count={health?.errors.top.length}>Errors</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          {!health ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-28 rounded-2xl" />)}</div> : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Meter label="Database" used={health.db.sizeBytes} limit={health.db.limitBytes} fmt={mb} icon={<Database />} />
                {health.storage && <Meter label="File storage" used={health.storage.bytes} limit={health.storage.limitBytes} fmt={mb} icon={<HardDrive />} />}
                <Meter label="Monthly active users" used={health.auth.active30d} limit={health.auth.mauLimit} icon={<Users />} />
                <Meter label="DB connections" used={health.db.connections} limit={health.db.maxConnections} icon={<Cpu />} />
              </div>
              <div className="grid gap-4 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                  <CardHeader title="Status" icon={<ShieldCheck />} />
                  <ul className="divide-y divide-line border-t border-line">
                    <Check ok label="Database" detail={`${health.db.cacheHitRatio != null ? `cache hit ${(health.db.cacheHitRatio * 100).toFixed(1)}% · ` : ''}up ${Math.round(health.db.uptimeSeconds / 3600)} h`} />
                    <Check ok={diag ? true : undefined} label="API Edge Function" detail={diag ? `v${diag.version} · DB round-trip ${diag.dbRoundTripMs} ms${diag.region ? ` · ${diag.region}` : ''}` : 'Checking…'} />
                    <Check ok={pushOk} label="Push notifications" detail={pushOk ? `${num(health.app.pushSubscriptions)} devices` : 'Not configured'} />
                    <Check ok={health.integrations.smsKey ? diag?.sms.ok ?? undefined : false} label="ProfJero Connect SMS" detail={!health.integrations.smsKey ? 'No key — add it under Integrations' : diag?.sms.ok ? `Reachable (${diag.sms.ms} ms)` : diag?.sms.error ?? (diag?.sms.status ? `HTTP ${diag.sms.status}` : 'Checking…')} />
                    <Check ok={health.integrations.cron} label="Scheduled jobs" detail={health.cron?.map((c) => `${c.job}: ${c.lastStatus ?? 'not run yet'}`).join(' · ')} />
                    <Check ok={health.errors.today === 0} label="Client errors today" detail={`${num(health.errors.today)} today · ${num(health.errors.last7d)} this week`} />
                  </ul>
                </Card>
                <Card>
                  <CardHeader title="People & accounts" icon={<Users />} />
                  <dl className="grid grid-cols-2 gap-px border-t border-line bg-line text-sm">
                    {[
                      ['Member records', health.app.members],
                      ['Awaiting review', health.app.unverifiedMembers],
                      ['Sign-in accounts', health.auth.users],
                      ['Device accounts', health.app.guestAccounts],
                      ['Staff', health.app.staff],
                      ['Deactivated', health.app.inactiveAccounts],
                      ['New (7 days)', health.auth.signups7d],
                      ['Active (7 days)', health.auth.active7d],
                    ].map(([k, v]) => (
                      <div key={String(k)} className="bg-surface px-4 py-3"><dt className="text-xs text-fg-3">{k}</dt><dd className="mt-0.5 font-semibold tabular">{num(Number(v))}</dd></div>
                    ))}
                  </dl>
                </Card>
              </div>
              <Card>
                <CardHeader title="Roles in use" icon={<KeyRound />} />
                <div className="flex flex-wrap gap-2 px-5 pb-5">
                  {health.roles.map((r) => <Badge key={r.role}>{r.label}: {r.count}</Badge>)}
                </div>
              </Card>
              <Card>
                <CardHeader title="Background jobs" icon={<Clock />} description="Daily 07:00 job (birthdays, reminders) and weekly clean-up." />
                {health.jobs.length === 0 ? <EmptyState compact title="No job runs yet" description="The daily job runs at 07:00 GMT." /> : (
                  <ul className="divide-y divide-line border-t border-line">
                    {health.jobs.map((j) => (
                      <li key={j.job} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                        {j.ok ? <CheckCircle2 className="size-4 text-success" /> : j.ok === false ? <XCircle className="size-4 text-danger" /> : <Clock className="size-4 text-fg-3" />}
                        <span className="font-medium">{j.job}</span>
                        <span className="text-fg-3">{relative(j.startedAt)}</span>
                        <code className="w-full truncate text-xs text-fg-3 sm:w-auto sm:flex-1">{JSON.stringify(j.detail ?? {})}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="errors" className="mt-4">
          <Card>
            <CardHeader title="Recent client errors" icon={<Bug />} description="Reported automatically by members’ and staff devices (de-duplicated, one row per error per day)." action={health?.errors.top.length ? <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => maintenance('clear_errors', 'Error log cleared')}>Clear</Button> : undefined} />
            {!health?.errors.top.length ? <EmptyState compact icon={<CheckCircle2 />} title="No errors reported" description="Nice — nothing has gone wrong on anyone’s device recently." /> : (
              <ul className="divide-y divide-line border-t border-line">
                {health.errors.top.map((e) => (
                  <li key={e.id} className="px-5 py-3">
                    <button type="button" className="flex w-full items-start gap-3 text-left" onClick={() => setOpenStack(openStack === e.id ? null : e.id)}>
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-sm font-medium">{e.message}</span>
                        <span className="mt-0.5 block text-xs text-fg-3">{e.url ?? '—'} · {relative(e.lastAt)}{e.release ? ` · v${e.release}` : ''}</span>
                      </span>
                      <Badge tone={e.count > 10 ? 'danger' : 'neutral'}>×{num(e.count)}</Badge>
                    </button>
                    {openStack === e.id && e.stack && <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-[11px] leading-relaxed text-fg-2">{e.stack}</pre>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="data" className="mt-4">
          <Card>
            <CardHeader title="Tables" icon={<Database />} description="Estimated rows and size on disk (including indexes)." />
            <div className="overflow-x-auto border-t border-line">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-fg-3"><tr><th className="px-5 py-2 font-medium">Table</th><th className="px-3 py-2 text-right font-medium">Rows</th><th className="px-3 py-2 text-right font-medium">Dead</th><th className="px-5 py-2 text-right font-medium">Size</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {ownTables.map((t) => (
                    <tr key={t.name}><td className="px-5 py-2 font-mono text-[13px]">{t.name}</td><td className="px-3 py-2 text-right tabular">{num(t.rows)}</td><td className={cn('px-3 py-2 text-right tabular', t.dead > t.rows && t.dead > 100 ? 'text-warning' : 'text-fg-3')}>{num(t.dead)}</td><td className="px-5 py-2 text-right tabular">{mb(t.sizeBytes)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="integrations" className="mt-4 space-y-4">
          <Card>
            <CardHeader title="ProfJero Connect (SMS)" icon={<Zap />} description="The secret key is stored on the server and can be replaced but never read back." />
            <div className="space-y-3 px-5 pb-5">
              <Badge tone={health?.integrations.smsKey ? 'success' : 'warning'}>{health?.integrations.smsKey ? 'Key saved' : 'No key yet'}</Badge>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <TextField className="flex-1" label="Secret API key" type="password" autoComplete="off" placeholder="pk_live_…" value={smsKey} onChange={(e) => setSmsKey(e.target.value)} />
                <Button onClick={saveSmsKey} disabled={!smsKey && !health?.integrations.smsKey}>{smsKey ? 'Save key' : 'Remove key'}</Button>
              </div>
              {diag?.sms.balance != null && <p className="text-xs text-fg-3">Balance: <code>{JSON.stringify(diag.sms.balance).slice(0, 160)}</code></p>}
            </div>
          </Card>
          <Card>
            <CardHeader title="Endpoints" icon={<Server />} />
            <ul className="divide-y divide-line border-t border-line text-sm">
              <li className="flex flex-wrap justify-between gap-2 px-5 py-3"><span>Supabase project</span><code className="text-xs text-fg-3">{config.supabaseUrl}</code></li>
              <li className="flex flex-wrap justify-between gap-2 px-5 py-3"><span>API function</span><code className="text-xs text-fg-3">{config.apiUrl}</code></li>
              <li className="flex flex-wrap justify-between gap-2 px-5 py-3"><span>App release</span><code className="text-xs text-fg-3">{config.release}</code></li>
              <li className="flex flex-wrap justify-between gap-2 px-5 py-3"><span>Signed in as</span><SessionInfo /></li>
            </ul>
          </Card>
        </TabsContent>

        <TabsContent value="maintenance" className="mt-4">
          <Card>
            <CardHeader title="Maintenance" icon={<Wrench />} description="Safe, logged actions. Clean-up also runs automatically every Sunday at 03:17." />
            <ul className="divide-y divide-line border-t border-line">
              {[
                { label: 'Clean up old data', hint: 'Removes errors > 30 days, notifications > 180 days, stale devices and rate-limit counters.', action: () => maintenance('cleanup', 'Clean-up complete'), icon: <Trash2 /> },
                { label: 'Refresh query statistics', hint: 'Runs ANALYZE so the database plans queries well after big imports.', action: () => maintenance('analyze', 'Statistics refreshed'), icon: <Database /> },
                { label: 'Run the daily job now', hint: 'Birthdays and tomorrow’s event reminders.', action: runDaily, icon: <Play /> },
              ].map((m) => (
                <li key={m.label} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                  <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{m.label}</span><span className="block text-xs text-fg-3">{m.hint}</span></span>
                  <Button size="sm" variant="outline" icon={m.icon} onClick={m.action}>Run</Button>
                </li>
              ))}
            </ul>
          </Card>
          <div className="mt-4" />
          <Switch checked={auto} onCheckedChange={setAuto} label="Auto-refresh every minute while this page is open" description="Stops when you leave the page or switch tabs." />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function SessionInfo() {
  const [s, setS] = useState('');
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const exp = data.session?.expires_at;
      setS(`${data.session?.user.email ?? '—'}${exp ? ` · token refreshes ${relative(new Date(exp * 1000))}` : ''}`);
    });
  }, []);
  return <code className="text-xs text-fg-3">{s}</code>;
}

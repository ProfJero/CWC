import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Bell, BellOff, BellRing, BookOpen, CalendarDays, CheckCheck, HeartHandshake, Megaphone, PlaySquare, Route, Settings2, Users, HandCoins, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { patchDoc } from '@/lib/db';
import { relative, toDate, friendlyDay } from '@/lib/format';
import { disablePush, enablePush, getPushState, needsInstallForPush, sendTestPush, type PushState } from '@/lib/push';
import { cn } from '@/lib/utils';
import type { AppNotification, NotificationKind } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Banner, EmptyState } from '@/components/ui/feedback';
import { Switch } from '@/components/ui/input';
import { Modal } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/tabs';
import { useUnreadNotifications } from '@/components/notification-bell';
import { MemberPage } from './ui';

const ICON: Record<string, typeof Bell> = { devotional: BookOpen, event: CalendarDays, care: HeartHandshake, sermon: PlaySquare, announcement: Megaphone, general: Bell, followup: Route, people: Users, giving: HandCoins, system: Wrench };
const TINT: Record<string, string> = {
  devotional: 'bg-accent-soft text-accent-soft-fg',
  event: 'bg-gold-50 text-gold-600 dark:bg-gold-500/15 dark:text-gold-300',
  care: 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
  sermon: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
  announcement: 'bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
};

const PREF_KINDS: { kind: NotificationKind; label: string; hint: string }[] = [
  { kind: 'announcement', label: 'Announcements', hint: 'Church news and service changes' },
  { kind: 'devotional', label: 'Devotionals', hint: 'The daily word' },
  { kind: 'event', label: 'Events & reminders', hint: 'New events, and a reminder the day before ones you RSVP’d for' },
  { kind: 'sermon', label: 'New sermons', hint: '' },
  { kind: 'care', label: 'Pastoral care', hint: 'Replies to your prayer and care requests' },
];

export default function Notifications() {
  const { user, profile, staff, refresh } = useAuth();
  const { items, markSeen, isUnread } = useUnreadNotifications();
  const [push, setPush] = useState<PushState | null>(null);
  const [filter, setFilter] = useState<'all' | 'unread' | 'church' | 'personal'>('all');
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [unreadAtOpen] = useState(() => new Set<string>());

  useEffect(() => {
    items.filter(isUnread).forEach((n) => unreadAtOpen.add(n.id));
    // Mark as read shortly after opening (keeps the "new" dots visible on this visit).
    const t = setTimeout(markSeen, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);
  useEffect(() => {
    getPushState().then(setPush).catch(() => {});
  }, []);

  const shown = useMemo(
    () =>
      items.filter((n) =>
        filter === 'all' ? true : filter === 'unread' ? unreadAtOpen.has(n.id) : filter === 'church' ? n.audience === 'all' : n.audience !== 'all',
      ),
    [items, filter, unreadAtOpen],
  );
  const groups = useMemo(() => {
    const out: { day: string; items: AppNotification[] }[] = [];
    for (const n of shown) {
      const day = friendlyDay(n.createdAt);
      const g = out[out.length - 1];
      if (g?.day === day) g.items.push(n);
      else out.push({ day, items: [n] });
    }
    return out;
  }, [shown]);

  async function turnOn() {
    try {
      const s = await enablePush();
      setPush(s);
      if (s === 'subscribed') toast.success('Notifications are on for this device');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function test() {
    try {
      const r = await sendTestPush();
      toast.success(r.delivered ? 'Test sent — it should pop up in a moment' : 'We couldn’t reach this device. Try turning notifications off and on.');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const prefs = profile?.notificationPrefs ?? {};
  async function savePrefs(next: typeof prefs) {
    if (!profile) return;
    try {
      await patchDoc('users', profile.id, { notificationPrefs: next });
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <MemberPage
      title="Notifications"
      action={
        <div className="flex gap-1.5">
          {items.some(isUnread) && <Button size="sm" variant="ghost" icon={<CheckCheck />} onClick={markSeen}>Mark all read</Button>}
          <Button size="icon-sm" variant="outline" aria-label="Notification settings" icon={<Settings2 />} onClick={() => setPrefsOpen(true)} />
        </div>
      }
    >
      {push && push !== 'subscribed' && push !== 'unsupported' && (
        <Banner tone={push === 'denied' ? 'warning' : 'brand'} icon={push === 'denied' ? <BellOff /> : <BellRing />} className="mb-4"
          action={push !== 'denied' && !needsInstallForPush() && <Button size="sm" onClick={turnOn}>Turn on</Button>}>
          {push === 'denied' ? 'Notifications are blocked. Enable them for this site in your browser settings.' : needsInstallForPush() ? 'On iPhone, add the app to your Home Screen first (Share → Add to Home Screen), then turn notifications on.' : 'Turn on notifications to get devotionals, reminders and replies instantly — free, no SMS needed.'}
        </Banner>
      )}

      <Segmented
        className="mb-4"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'unread', label: `New${unreadAtOpen.size ? ` (${unreadAtOpen.size})` : ''}` },
          { value: 'church', label: 'Church' },
          ...(user ? [{ value: 'personal' as const, label: staff ? 'For me' : 'Personal' }] : []),
        ]}
      />

      {groups.length === 0 ? (
        <div className="card"><EmptyState icon={<Bell />} title={filter === 'all' ? 'No notifications yet' : 'Nothing here'} description="Church updates and replies to your requests show up here." /></div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.day}>
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-fg-3">{g.day}</h2>
              <ul className="card divide-y divide-line overflow-hidden">
                {g.items.map((n) => {
                  const Icon = ICON[n.kind] ?? Bell;
                  const isNew = unreadAtOpen.has(n.id);
                  return (
                    <li key={n.id}>
                      <Link to={n.url || '/'} className={cn('flex gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2', isNew && 'bg-accent-soft/40')}>
                        <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', TINT[n.kind] ?? 'bg-surface-2 text-fg-2')}><Icon className="size-5" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-start justify-between gap-2"><span className={isNew ? 'font-semibold' : 'font-medium'}>{n.title}</span>{isNew && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-500" aria-label="New" />}</span>
                          {n.body && <span className="mt-0.5 block text-sm text-fg-2">{n.body}</span>}
                          <span className="mt-1 block text-xs text-fg-3" title={toDate(n.createdAt)?.toLocaleString()}>{relative(n.createdAt)}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <Modal open={prefsOpen} onOpenChange={setPrefsOpen} title="Notification settings" size="sm" footer={<Button onClick={() => setPrefsOpen(false)}>Done</Button>}>
        <div className="space-y-5">
          <div className="rounded-2xl bg-surface-2 p-4">
            <p className="text-sm font-semibold">This device</p>
            <p className="mt-0.5 text-xs text-fg-3">{push === 'subscribed' ? 'Notifications are on.' : push === 'denied' ? 'Blocked in browser settings.' : push === 'unsupported' ? 'This browser doesn’t support notifications.' : 'Notifications are off.'}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {push === 'subscribed' ? (
                <>
                  {user && <Button size="sm" variant="outline" onClick={test}>Send a test</Button>}
                  <Button size="sm" variant="ghost" onClick={async () => setPush(await disablePush())}>Turn off</Button>
                </>
              ) : push !== 'denied' && push !== 'unsupported' && <Button size="sm" onClick={turnOn}>Turn on</Button>}
            </div>
          </div>
          {user ? (
            <div className="space-y-3">
              <Switch checked={prefs.push !== false} onCheckedChange={(v) => savePrefs({ ...prefs, push: v })} label="Push notifications to my devices" description="Your inbox here always keeps everything." />
              {prefs.push !== false && PREF_KINDS.map((k) => (
                <Switch key={k.kind} checked={prefs.kinds?.[k.kind] !== false} onCheckedChange={(v) => savePrefs({ ...prefs, kinds: { ...(prefs.kinds ?? {}), [k.kind]: v } })} label={k.label} description={k.hint || undefined} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-fg-3">Introduce yourself to choose which notifications you get and receive replies to your requests.</p>
          )}
        </div>
      </Modal>
    </MemberPage>
  );
}

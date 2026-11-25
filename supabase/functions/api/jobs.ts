import type { Env } from './env.ts';
import { Supa, serverConfig } from './supa.ts';
import { cleanSmsBody, pj } from './profjero.ts';

const dayOf = (d: Date) => d.toISOString().slice(0, 10); // Africa/Accra = UTC

interface ChurchSettings {
  autoBirthdaySms?: boolean;
  birthdaySms?: string;
  smsSenderId?: string;
  autoEventReminders?: boolean;
  autoDevotionalPush?: boolean;
  name?: string;
}

/**
 * Daily 07:00 job (pg_cron → this function). Idempotent per day:
 *  - birthday SMS (if enabled and SMS is configured)
 *  - push reminders to everyone who RSVP'd for tomorrow's events
 *  - optional "today's devotional" push
 */
export async function dailyJob(env: Env, now = new Date(), opts: { force?: boolean } = {}) {
  const db = new Supa(env);
  const today = dayOf(now);
  if (!opts.force) {
    const done = await db.select('job_runs', `job=eq.daily&ok=eq.true&started_at=gte.${today}T00:00:00Z&select=id&limit=1`);
    if (done.length) return { skipped: 'already ran today' };
  }
  const [run] = await db.insert<{ id: number }>('job_runs', { job: 'daily' });
  const detail: Record<string, unknown> = {};
  let ok = true;
  try {
    const [row] = await db.select<{ data: ChurchSettings }>('settings', 'id=eq.church&select=data');
    const s = row?.data ?? {};

    // 1. Birthdays
    const cfg = await serverConfig(env);
    const apiKey = env.PROFJERO_API_KEY || cfg.profjero_api_key;
    if (s.autoBirthdaySms && s.birthdaySms && apiKey) {
      const md = today.slice(5);
      const people = (await db.select<{ phone: string; first_name: string; full_name: string; sms_opt_out: boolean; membership_status: string }>(
        'members', `birth_month_day=eq.${md}&select=phone,first_name,full_name,sms_opt_out,membership_status&limit=2000`,
      )).filter((m) => m.phone && !m.sms_opt_out && !['deceased', 'transferred'].includes(m.membership_status));
      if (people.length) {
        const res = await pj(apiKey, env.PROFJERO_BASE_URL, '/v1/sms/send', {
          method: 'POST',
          idempotencyKey: `birthday-${today}`,
          body: cleanSmsBody({ message: s.birthdaySms, senderId: s.smsSenderId, recipients: people.map((p) => ({ phone: p.phone, fields: Object.fromEntries(Object.entries({ first_name: p.first_name, name: p.full_name }).filter(([, v]) => v)) })) }, env.PROFJERO_SENDER_ID),
        });
        detail.birthdays = { recipients: people.length, status: res.status };
      } else detail.birthdays = { recipients: 0 };
    } else detail.birthdays = 'off';

    // 2. Event reminders (tomorrow)
    if (s.autoEventReminders !== false) {
      const tomorrow = dayOf(new Date(now.getTime() + 864e5));
      const events = await db.select<{ id: string; title: string; start_at: string; location: string | null }>(
        'events', `status=eq.published&start_at=gte.${tomorrow}T00:00&start_at=lte.${tomorrow}T23:59&select=id,title,start_at,location`,
      );
      let reminders = 0;
      for (const e of events) {
        const rsvps = await db.select<{ uid: string }>('rsvps', `event_id=eq.${e.id}&select=uid&limit=1000`);
        if (!rsvps.length) continue;
        const time = e.start_at.slice(11, 16);
        await db.insert('notifications', rsvps.map((r) => ({
          title: `Tomorrow: ${e.title}`.slice(0, 140),
          body: `See you at ${time}${e.location ? ` · ${e.location}` : ''}. Tap for details.`,
          url: `/events/${e.id}`,
          kind: 'event',
          audience: 'user',
          target_uid: r.uid,
        })), false);
        reminders += rsvps.length;
      }
      detail.eventReminders = { events: events.length, reminders };
    }

    // 3. Today's devotional
    if (s.autoDevotionalPush) {
      const [d] = await db.select<{ id: string; title: string; scripture: string }>('devotionals', `status=eq.published&date=eq.${today}&select=id,title,scripture&limit=1`);
      if (d) {
        await db.insert('notifications', { title: `Today’s devotional: ${d.title}`.slice(0, 140), body: d.scripture || 'Start your day in the Word.', url: `/devotionals/${d.id}`, kind: 'devotional', audience: 'all' }, false);
        detail.devotional = d.id;
      }
    }
  } catch (e) {
    ok = false;
    detail.error = (e as Error).message;
  }
  await db.update('job_runs', `id=eq.${run.id}`, { finished_at: new Date().toISOString(), ok, detail });
  return { ok, ...detail };
}

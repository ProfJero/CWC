import { supabase } from './supabase';
import { useCollection, useDocument, useSingle } from './db';
import type {
  Announcement,
  AppNotification,
  AuditLog,
  Campaign,
  CareLog,
  CareNote,
  CareRequest,
  ChurchEvent,
  Devotional,
  Expense,
  FollowUp,
  Gift,
  Group,
  Household,
  Member,
  Pledge,
  PrayerWallItem,
  RoleDef,
  Rsvp,
  Sermon,
  Service,
  AttendanceRecord,
  SmsMessage,
  SmsTemplate,
  Testimony,
  UserProfile,
  AppError,
} from './types';

const from = (t: string) => supabase.from(t);

/* People ------------------------------------------------------------ */
export const useMembers = (enabled = true) =>
  useCollection<Member>(enabled ? 'members:all' : null, 'members', () => from('members').select('*').order('full_name').limit(5000));
export const useMember = (id?: string | null) => useDocument<Member>(id ? `members/${id}` : null);
export const useUnverifiedMembers = (enabled = true) =>
  useCollection<Member>(enabled ? 'members:unverified' : null, 'members', () => from('members').select('*').eq('verified', false).order('created_at', { ascending: false }).limit(200));
export const useHouseholdMembers = (householdId?: string | null) =>
  useCollection<Member>(householdId ? `members:hh:${householdId}` : null, 'members', () => from('members').select('*').eq('household_id', householdId!));
export const useHousehold = (id?: string | null) => useDocument<Household>(id ? `households/${id}` : null);
export const useGroups = (enabled = true) => useCollection<Group>(enabled ? 'groups:all' : null, 'groups', () => from('groups').select('*').order('name'));
export const useGroup = (id?: string) => useDocument<Group>(id ? `groups/${id}` : null);
export const useFollowUps = (enabled = true) =>
  useCollection<FollowUp>(enabled ? 'followups:all' : null, 'followups', () => from('followups').select('*').order('created_at', { ascending: false }).limit(500));
export const useUsers = (enabled = true) =>
  useCollection<UserProfile>(enabled ? 'users:all' : null, 'users', () => from('users').select('*, uid:id').order('full_name'));
export const useRoles = (enabled = true) =>
  useCollection<RoleDef>(enabled ? 'roles:all' : null, 'roles', () => from('roles').select('*').order('sort').order('label'));

/* Attendance -------------------------------------------------------- */
export const useServices = (enabled = true, max = 120) =>
  useCollection<Service>(enabled ? `services:${max}` : null, 'services', () => from('services').select('*').order('date', { ascending: false }).limit(max));
export const useLiveServices = () =>
  useCollection<Service>('services:live', 'services', () => from('services').select('*').eq('is_open', true).order('date', { ascending: false }).limit(5));
export const useService = (id?: string, live = false) => useDocument<Service>(id ? `services/${id}` : null, { live, alsoTables: ['attendance'] });
export const useServiceAttendance = (serviceId?: string, live = false) =>
  useCollection<AttendanceRecord>(serviceId ? `attendance:svc:${serviceId}` : null, 'attendance', () => from('attendance').select('*').eq('service_id', serviceId!).order('checked_in_at', { ascending: false }), { live: live ? { filter: `service_id=eq.${serviceId}` } : false });
export const useMemberAttendance = (memberId?: string | null) =>
  useCollection<AttendanceRecord>(memberId ? `attendance:m:${memberId}` : null, 'attendance', () => from('attendance').select('*').eq('member_id', memberId!).order('date', { ascending: false }).limit(60));
export const useMyServiceCheckIn = (serviceId?: string, memberId?: string | null) =>
  useSingle<AttendanceRecord>(serviceId && memberId ? `attendance:me:${serviceId}:${memberId}` : null, 'attendance', () => from('attendance').select('*').eq('service_id', serviceId!).eq('member_id', memberId!).maybeSingle());

/* Giving ------------------------------------------------------------ */
export const useGiftsSince = (since: string, enabled = true) =>
  useCollection<Gift>(enabled ? `gifts:since:${since}` : null, 'gifts', () => from('gifts').select('*').gte('date', since).order('date', { ascending: false }).limit(10000));
export const useMemberGifts = (memberId?: string | null) =>
  useCollection<Gift>(memberId ? `gifts:m:${memberId}` : null, 'gifts', () => from('gifts').select('*').eq('member_id', memberId!).order('date', { ascending: false }).limit(200));
export const useExpensesSince = (since: string, enabled = true) =>
  useCollection<Expense>(enabled ? `expenses:since:${since}` : null, 'expenses', () => from('expenses').select('*').gte('date', since).order('date', { ascending: false }).limit(5000));
export const useCampaigns = (enabled = true) =>
  useCollection<Campaign>(enabled ? 'campaigns:all' : null, 'campaigns', () => from('campaigns').select('*').order('created_at', { ascending: false }));
export const usePledges = (enabled = true) =>
  useCollection<Pledge>(enabled ? 'pledges:all' : null, 'pledges', () => from('pledges').select('*').order('created_at', { ascending: false }).limit(2000));
export const useMemberPledges = (memberId?: string | null) =>
  useCollection<Pledge>(memberId ? `pledges:m:${memberId}` : null, 'pledges', () => from('pledges').select('*').eq('member_id', memberId!));

/* Content ----------------------------------------------------------- */
export const useEvents = (enabled = true) =>
  useCollection<ChurchEvent>(enabled ? 'events:all' : null, 'events', () => from('events').select('*').order('start_at', { ascending: false }).limit(300));
export const usePublishedEvents = () =>
  useCollection<ChurchEvent>('events:pub', 'events', () => from('events').select('*').eq('status', 'published').order('start_at', { ascending: false }).limit(150));
export const useEvent = (id?: string) => useDocument<ChurchEvent>(id ? `events/${id}` : null, { alsoTables: ['rsvps'] });
export const useRsvps = (eventId?: string, enabled = true) =>
  useCollection<Rsvp>(eventId && enabled ? `rsvps:${eventId}` : null, 'rsvps', () => from('rsvps').select('*').eq('event_id', eventId!).order('created_at'));
export const useMyRsvp = (eventId?: string, uid?: string) =>
  useSingle<Rsvp>(eventId && uid ? `rsvps:${eventId}:${uid}` : null, 'rsvps', () => from('rsvps').select('*').eq('event_id', eventId!).eq('uid', uid!).maybeSingle());
export const useMyRsvps = (uid?: string) =>
  useCollection<Rsvp>(uid ? `rsvps:mine:${uid}` : null, 'rsvps', () => from('rsvps').select('*').eq('uid', uid!));

export const useDevotionals = (enabled = true) =>
  useCollection<Devotional>(enabled ? 'devotionals:all' : null, 'devotionals', () => from('devotionals').select('*').order('date', { ascending: false }).limit(400));
export const usePublishedDevotionals = (today: string) =>
  useCollection<Devotional>(`devotionals:pub:${today}`, 'devotionals', () =>
    from('devotionals').select('*').eq('status', 'published').lte('date', today).order('date', { ascending: false }).limit(120),
  );
export const useDevotional = (id?: string) => useDocument<Devotional>(id ? `devotionals/${id}` : null);

export const useSermons = (enabled = true) =>
  useCollection<Sermon>(enabled ? 'sermons:all' : null, 'sermons', () => from('sermons').select('*').order('date', { ascending: false }).limit(300));
export const usePublishedSermons = () =>
  useCollection<Sermon>('sermons:pub', 'sermons', () => from('sermons').select('*').eq('status', 'published').order('date', { ascending: false }).limit(150));
export const useSermon = (id?: string) => useDocument<Sermon>(id ? `sermons/${id}` : null);

export const useAnnouncements = (enabled = true) =>
  useCollection<Announcement>(enabled ? 'announcements:all' : null, 'announcements', () => from('announcements').select('*').order('created_at', { ascending: false }).limit(200));
export const usePublishedAnnouncements = () =>
  useCollection<Announcement>('announcements:pub', 'announcements', () =>
    from('announcements').select('*').eq('status', 'published').order('created_at', { ascending: false }).limit(30),
  );

/* Care -------------------------------------------------------------- */
export const useCareRequests = (enabled = true) =>
  useCollection<CareRequest>(enabled ? 'care:all' : null, 'care_requests', () => from('care_requests').select('*').order('created_at', { ascending: false }).limit(500));
export const useMyCareRequests = (uid?: string) =>
  useCollection<CareRequest>(uid ? `care:mine:${uid}` : null, 'care_requests', () => from('care_requests').select('*').eq('uid', uid!).order('created_at', { ascending: false }));
export const usePrayerWall = (deviceKey: string, signedIn: string) =>
  useCollection<PrayerWallItem>(`care:wall:${signedIn}`, 'care_requests', () => supabase.rpc('get_prayer_wall', { p_key: deviceKey, p_limit: 60 }), { alsoTables: ['care_prayers'] });
export const useCareRequest = (id?: string, live = false) => useDocument<CareRequest>(id ? `care_requests/${id}` : null, { live });
export const useCareNotes = (requestId?: string) =>
  useCollection<CareNote>(requestId ? `care_notes:${requestId}` : null, 'care_notes', () => from('care_notes').select('*').eq('care_request_id', requestId!).order('at', { ascending: false }));
export const useCareLogs = (enabled = true) =>
  useCollection<CareLog>(enabled ? 'carelogs:all' : null, 'care_logs', () => from('care_logs').select('*').order('date', { ascending: false }).limit(300));
export const useMemberCareLogs = (memberId?: string | null, enabled = true) =>
  useCollection<CareLog>(memberId && enabled ? `carelogs:m:${memberId}` : null, 'care_logs', () => from('care_logs').select('*').eq('member_id', memberId!).order('date', { ascending: false }));
export const useTestimonies = (enabled = true) =>
  useCollection<Testimony>(enabled ? 'testimonies:all' : null, 'testimonies', () => from('testimonies').select('*').order('created_at', { ascending: false }).limit(200));
export const usePublishedTestimonies = () =>
  useCollection<Testimony>('testimonies:pub', 'testimonies', () => from('testimonies').select('*').eq('status', 'published').order('created_at', { ascending: false }).limit(40));

/* Messaging --------------------------------------------------------- */
export const useSmsMessages = (enabled = true) =>
  useCollection<SmsMessage>(enabled ? 'sms:all' : null, 'sms_messages', () => from('sms_messages').select('*').order('created_at', { ascending: false }).limit(200));
export const useSmsTemplates = (enabled = true) =>
  useCollection<SmsTemplate>(enabled ? 'smstpl:all' : null, 'sms_templates', () => from('sms_templates').select('*').order('name'));

/**
 * The notification feed: whatever row level security lets this person see — church-wide posts,
 * messages addressed to them, and staff alerts for their role. One live channel while open.
 */
export const useNotificationsFeed = (uid?: string, staffBroadcaster = false) =>
  useCollection<AppNotification>(`notif:${uid ?? 'anon'}`, 'notifications', () => {
    let q = from('notifications').select('*').order('created_at', { ascending: false }).limit(60);
    // Broadcasters can read every notification; keep their personal feed personal.
    if (staffBroadcaster && uid) q = q.or(`audience.eq.all,target_uid.eq.${uid},audience.eq.perm`);
    return q;
  }, { live: Boolean(uid), alsoTables: ['notification_reads'] });
export const useNotificationReads = (uid?: string) =>
  useCollection<{ notificationId: string; readAt: string }>(uid ? `notif-reads:${uid}` : null, 'notification_reads', () =>
    from('notification_reads').select('notification_id, read_at').gte('read_at', new Date(Date.now() - 120 * 864e5).toISOString()).limit(1000),
  );
export const useSentNotifications = (enabled = true) =>
  useCollection<AppNotification>(enabled ? 'notif:sent' : null, 'notifications', () => from('notifications').select('*').eq('audience', 'all').order('created_at', { ascending: false }).limit(100));

export const useAuditLogs = (enabled = true) =>
  useCollection<AuditLog>(enabled ? 'audit:recent' : null, 'audit_logs', () => from('audit_logs').select('*').order('at', { ascending: false }).limit(300));

/* Developer --------------------------------------------------------- */
export const useAppErrors = (enabled = true) =>
  useCollection<AppError>(enabled ? 'app_errors:recent' : null, 'app_errors', () => from('app_errors').select('*').order('last_at', { ascending: false }).limit(100));

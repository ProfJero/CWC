import type { Role, RoleDef } from './types';

/**
 * Permission catalog. Roles are stored in the database (public.roles) as lists of these keys,
 * so new roles can be added from Users & roles without code changes. Keep this list in sync with
 * private.permission_catalog in supabase/migrations — the database is what enforces access.
 */
export const PERMISSION_GROUPS = [
  {
    label: 'People',
    items: [
      { key: 'dashboard.view', label: 'Open the staff dashboard' },
      { key: 'people.view', label: 'View the member directory' },
      { key: 'people.manage', label: 'Add and edit people' },
      { key: 'people.delete', label: 'Delete and merge records' },
      { key: 'groups.manage', label: 'Manage groups & ministries' },
      { key: 'followups.manage', label: 'Work on follow-ups' },
    ],
  },
  {
    label: 'Ministry',
    items: [
      { key: 'attendance.manage', label: 'Run services & check-in' },
      { key: 'events.manage', label: 'Create and publish events' },
      { key: 'content.manage', label: 'Devotionals, sermons, announcements' },
      { key: 'care.view', label: 'See pastoral care requests' },
      { key: 'care.manage', label: 'Reply to and manage care' },
      { key: 'care.confidential', label: 'Counselling & confidential notes' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { key: 'giving.view', label: 'View giving' },
      { key: 'giving.manage', label: 'Record giving & pledges' },
      { key: 'expenses.manage', label: 'Record expenses' },
    ],
  },
  {
    label: 'Communication',
    items: [
      { key: 'messaging.sms', label: 'Send SMS' },
      { key: 'messaging.push', label: 'Send app notifications' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { key: 'reports.view', label: 'View reports' },
      { key: 'users.manage', label: 'Manage accounts' },
      { key: 'roles.manage', label: 'Create and edit roles' },
      { key: 'settings.manage', label: 'Church settings' },
      { key: 'audit.view', label: 'Activity log' },
      { key: 'system.monitor', label: 'Developer console & system health' },
    ],
  },
] as const;

export const PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));
export type Permission = (typeof PERMISSIONS)[number];

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'gold';

/** Fallback labels while roles load (the database is the source of truth). */
export const ROLE_META: Record<string, { label: string; description: string; tone: BadgeTone }> = {
  super_admin: { label: 'Super Admin', description: 'Full access, including roles, admins and settings', tone: 'danger' },
  developer: { label: 'Developer', description: 'Maintains the platform: monitoring, diagnostics and integrations', tone: 'info' },
  admin: { label: 'Administrator', description: 'Runs day-to-day church operations', tone: 'brand' },
  pastor: { label: 'Pastor', description: 'People, care, content and messaging', tone: 'info' },
  treasurer: { label: 'Treasurer', description: 'Giving, pledges and expenses', tone: 'success' },
  secretary: { label: 'Secretary', description: 'People, attendance, events and messaging', tone: 'warning' },
  staff: { label: 'Ministry Staff', description: 'Attendance and follow-ups', tone: 'neutral' },
  viewer: { label: 'Viewer', description: 'Read-only dashboards and reports', tone: 'neutral' },
  member: { label: 'Member', description: 'Member app only', tone: 'neutral' },
};

export const PROTECTED_ROLES = ['super_admin', 'developer'];

export function roleMeta(role: Role | null | undefined, roles?: RoleDef[]) {
  const def = roles?.find((r) => r.key === role);
  if (def) return { label: def.label, description: def.description, tone: (def.tone as BadgeTone) || 'neutral' };
  return ROLE_META[role ?? 'member'] ?? { label: String(role ?? 'Member'), description: '', tone: 'neutral' as BadgeTone };
}

export function hasPermission(permissions: readonly string[] | null | undefined, permission: Permission) {
  return !!permissions?.includes(permission);
}

/** Roles this person may assign: never more powerful than their own permissions. */
export function assignableRoles(actorRole: Role | null, actorPerms: readonly string[], roles: RoleDef[]): RoleDef[] {
  if (!actorPerms.includes('users.manage')) return [];
  return roles.filter((r) => r.permissions.every((p) => actorPerms.includes(p)) && (r.key !== 'super_admin' || actorRole === 'super_admin'));
}

/** Can the actor change this person's role / status / password? */
export function canManageAccount(actorRole: Role | null, actorPerms: readonly string[], targetRole: Role, roles: RoleDef[]) {
  if (!actorPerms.includes('users.manage')) return false;
  const target = roles.find((r) => r.key === targetRole);
  if (targetRole === 'super_admin' && actorRole !== 'super_admin') return false;
  return (target?.permissions ?? []).every((p) => actorPerms.includes(p));
}

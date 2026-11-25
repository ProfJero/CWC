import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ShieldCheck, UserPlus, MoreHorizontal, Link2, Ban, CheckCircle2, KeyRound, Sparkles, UserRoundPlus, Trash2, Plus, Lock, Pencil, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth, isPhoneLogin } from '@/lib/auth';
import { useMembers, useRoles, useUsers } from '@/lib/queries';
import { createDoc, invalidate, patchDoc, rpc } from '@/lib/db';
import { assignableRoles, canManageAccount, PERMISSION_GROUPS, PROTECTED_ROLES, roleMeta } from '@/lib/permissions';
import { formatPhone, normalizePhone, isValidPhone } from '@/lib/phone';
import { relative, toDate } from '@/lib/format';
import { api } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import type { Member, RoleDef, UserProfile } from '@/lib/types';
import type { BadgeTone } from '@/lib/permissions';
import { Page, PageHeader, Toolbar } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { DataTable, type Column } from '@/components/ui/table';
import { Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SearchInput, Field, Select, TextField, Textarea, Checkbox } from '@/components/ui/input';
import { Modal } from '@/components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { MemberPicker } from '@/components/member-picker';
import { Banner, EmptyState, SkeletonRows } from '@/components/ui/feedback';
import { useConfirm } from '@/components/ui/confirm';
import { memberPayload, EMPTY_MEMBER } from '../people/shared';

function tempPassword() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return 'Cwc-' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => a[b % a.length]).join('');
}

export default function Users() {
  const { role: myRole, user: me, permissions, can } = useAuth();
  const confirm = useConfirm();
  const { data: users, loading } = useUsers();
  const { data: members } = useMembers();
  const { data: roles } = useRoles();
  const [filter, setFilter] = useState<'staff' | 'members' | 'all'>('staff');
  const [q, setQ] = useState('');
  const [roleFor, setRoleFor] = useState<UserProfile | null>(null);
  const [linkFor, setLinkFor] = useState<UserProfile | null>(null);
  const [create, setCreate] = useState(false);
  const [shown, setShown] = useState<{ name: string; password: string } | null>(null);
  const canAssign = assignableRoles(myRole, permissions, roles);
  const staffKeys = useMemo(() => new Set(roles.filter((r) => r.permissions.length > 0).map((r) => r.key)), [roles]);
  const isStaffRole = (r: string) => staffKeys.has(r);

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const unlinkedByPhone = useMemo(() => new Map(members.filter((m) => !m.uid && m.phone).map((m) => [m.phone, m])), [members]);
  const suggestions = users.filter((u) => !u.memberId && u.phone && unlinkedByPhone.has(normalizePhone(u.phone)));

  const rows = users.filter(
    (u) => (filter === 'all' || (filter === 'staff' ? isStaffRole(u.role) : !isStaffRole(u.role))) && `${u.fullName} ${u.email} ${u.phone}`.toLowerCase().includes(q.toLowerCase()),
  );
  const editable = (u: UserProfile) => u.uid !== me?.uid && canManageAccount(myRole, permissions, u.role, roles);

  async function link(u: UserProfile, m: Member) {
    await rpc('link_user_member', { p_user: u.id, p_member: m.id }, ['users', 'members']);
    toast.success(`${u.fullName} linked to ${m.fullName}`);
  }
  async function unlink(u: UserProfile) {
    await rpc('link_user_member', { p_user: u.id, p_member: null }, ['users', 'members']);
    toast.success('Unlinked');
  }
  async function createMemberFrom(u: UserProfile) {
    const [firstName, ...rest] = u.fullName.split(' ');
    const id = await createDoc('members', { ...memberPayload({ ...EMPTY_MEMBER, firstName, lastName: rest.join(' '), phone: u.phone ?? '', email: u.email, membershipStatus: 'member' }) }, { audit: `Created member record for ${u.fullName}` });
    await rpc('link_user_member', { p_user: u.id, p_member: id }, ['users', 'members']);
    toast.success('Member record created and linked');
  }
  async function toggleActive(u: UserProfile) {
    const off = u.isActive !== false;
    if (off && !(await confirm({ title: `Deactivate ${u.fullName}?`, description: 'They lose access immediately. You can reactivate them later.', danger: true, confirmLabel: 'Deactivate' }))) return;
    try {
      await patchDoc('users', u.id, { isActive: !off }, { audit: `${off ? 'Deactivated' : 'Reactivated'} ${u.fullName}` });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function resetPassword(u: UserProfile) {
    if (!(await confirm({ title: `Reset ${u.fullName}’s password?`, description: 'A temporary password is created. They’ll be asked to choose a new one when they sign in.', confirmLabel: 'Reset password' }))) return;
    const temp = tempPassword();
    try {
      await api(`/v1/admin/users/${u.uid}/password`, { method: 'POST', json: { password: temp } });
      setShown({ name: u.fullName, password: temp });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function del(u: UserProfile) {
    if (!(await confirm({ title: `Delete ${u.fullName}’s account?`, description: 'They can no longer sign in. Their church member record (giving, attendance) is kept.', danger: true, confirmLabel: 'Delete account' }))) return;
    try {
      await api(`/v1/admin/users/${u.uid}`, { method: 'DELETE' });
      invalidate('users', 'members');
      toast.success('Account deleted');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const tone = (r: string) => roleMeta(r, roles).tone;
  const label = (r: string) => roleMeta(r, roles).label;

  const cols: Column<UserProfile>[] = [
    {
      key: 'name', header: 'Name', sort: (u) => u.fullName,
      cell: (u) => (
        <div className="flex items-center gap-3">
          <Avatar name={u.fullName} src={u.photoUrl} size="sm" />
          <div className="min-w-0"><div className="truncate font-medium">{u.fullName || 'Unnamed'}{u.uid === me?.uid && <span className="ml-1.5 text-xs font-normal text-fg-3">(you)</span>}</div><div className="truncate text-xs text-fg-3">{u.email && !isPhoneLogin(u.email) ? u.email : formatPhone(u.phone)}</div></div>
        </div>
      ),
    },
    { key: 'role', header: 'Role', sort: (u) => u.role, cell: (u) => <span className="flex flex-wrap gap-1"><Badge tone={tone(u.role)}>{label(u.role)}</Badge>{u.isGuest && <Badge>No password yet</Badge>}</span> },
    { key: 'member', header: 'Member record', hideBelow: 'md', cell: (u) => (u.memberId ? <Link to={`/admin/people/${u.memberId}`} onClick={(e) => e.stopPropagation()} className="text-sm text-accent hover:underline dark:text-brand-300">{memberById.get(u.memberId)?.fullName ?? 'Linked'}</Link> : <span className="text-xs text-fg-3">Not linked</span>) },
    { key: 'status', header: 'Status', cell: (u) => (u.isActive === false ? <Badge tone="danger">Deactivated</Badge> : <Badge tone="success" dot>Active</Badge>) },
    { key: 'seen', header: 'Last sign-in', hideBelow: 'lg', sort: (u) => toDate(u.lastLogin)?.getTime() ?? 0, cell: (u) => <span className="text-fg-3">{u.lastLogin ? relative(u.lastLogin) : 'Never'}</span> },
    {
      key: 'actions', header: '', className: 'w-12',
      cell: (u) => editable(u) && (
        <Menu>
          <MenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`Manage ${u.fullName}`} icon={<MoreHorizontal />} onClick={(e) => e.stopPropagation()} /></MenuTrigger>
          <MenuContent>
            <MenuItem icon={<ShieldCheck />} onSelect={() => setRoleFor(u)}>Change role</MenuItem>
            {u.memberId ? <MenuItem icon={<Link2 />} onSelect={() => unlink(u)}>Unlink member record</MenuItem> : <>
              <MenuItem icon={<Link2 />} onSelect={() => setLinkFor(u)}>Link to member record</MenuItem>
              <MenuItem icon={<UserRoundPlus />} onSelect={() => createMemberFrom(u)}>Create member record</MenuItem>
            </>}
            <MenuItem icon={<KeyRound />} onSelect={() => resetPassword(u)}>Reset password</MenuItem>
            <MenuSeparator />
            <MenuItem icon={u.isActive === false ? <CheckCircle2 /> : <Ban />} onSelect={() => toggleActive(u)} danger={u.isActive !== false}>{u.isActive === false ? 'Reactivate' : 'Deactivate'}</MenuItem>
            <MenuItem icon={<Trash2 />} danger onSelect={() => del(u)}>Delete account</MenuItem>
          </MenuContent>
        </Menu>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader title="Users & roles" description="Who can sign in, and what each person can do." actions={<Button size="sm" icon={<UserPlus />} onClick={() => setCreate(true)}>Add staff account</Button>} />
      <Tabs defaultValue="accounts">
        <TabsList>
          <TabsTrigger value="accounts" count={users.length}>Accounts</TabsTrigger>
          <TabsTrigger value="roles" count={roles.length}>Roles & permissions</TabsTrigger>
        </TabsList>
        <TabsContent value="accounts" className="mt-4">
          {suggestions.length > 0 && (
            <Banner tone="brand" icon={<Sparkles />} className="mb-4" title={`${suggestions.length} app ${suggestions.length === 1 ? 'account matches' : 'accounts match'} a member by phone`} action={<Button size="xs" onClick={async () => { for (const u of suggestions) await link(u, unlinkedByPhone.get(normalizePhone(u.phone))!); }}>Link all</Button>}>
              Check the names match, then link — members then see their giving history, groups and attendance in the app.
            </Banner>
          )}
          <Toolbar>
            <SearchInput value={q} onChange={setQ} placeholder="Search accounts" className="sm:w-72" />
            <Segmented value={filter} onChange={setFilter} options={[{ value: 'staff', label: `Staff (${users.filter((u) => isStaffRole(u.role)).length})` }, { value: 'members', label: `Members (${users.filter((u) => !isStaffRole(u.role)).length})` }, { value: 'all', label: 'All' }]} />
          </Toolbar>
          <DataTable
            rows={rows}
            columns={cols}
            rowKey={(u) => u.id}
            isLoading={loading}
            loading={<SkeletonRows />}
            defaultSort={{ key: 'name', dir: 'asc' }}
            onRowClick={(u) => editable(u) && setRoleFor(u)}
            mobile={(u) => (
              <div className="flex items-center gap-3">
                <Avatar name={u.fullName} size="md" />
                <div className="min-w-0 flex-1"><div className="truncate font-medium">{u.fullName || 'Unnamed'}</div><div className="truncate text-xs text-fg-3">{u.email && !isPhoneLogin(u.email) ? u.email : formatPhone(u.phone)}</div></div>
                <Badge tone={u.isActive === false ? 'danger' : tone(u.role)}>{u.isActive === false ? 'Off' : label(u.role)}</Badge>
              </div>
            )}
            empty={<EmptyState icon={<ShieldCheck />} title="No accounts" />}
          />
        </TabsContent>
        <TabsContent value="roles" className="mt-4">
          <RolesPanel roles={roles} users={users} canEdit={can('roles.manage')} myPerms={permissions} />
        </TabsContent>
      </Tabs>

      <RoleModal u={roleFor} onClose={() => setRoleFor(null)} roles={canAssign} />
      <Modal open={!!linkFor} onOpenChange={(o) => !o && setLinkFor(null)} title="Link to a member record" description={linkFor?.fullName} size="sm" footer={<Button variant="outline" onClick={() => setLinkFor(null)}>Close</Button>}>
        <div className="min-h-72">
          <MemberPicker value={null} onChange={async (v) => { if (v?.member && linkFor) { await link(linkFor, v.member); setLinkFor(null); } }} autoFocus />
        </div>
      </Modal>
      <CreateStaff open={create} onOpenChange={setCreate} roles={canAssign.filter((r) => r.key !== 'member')} onCreated={(name, password) => setShown({ name, password })} />
      <Modal open={!!shown} onOpenChange={(o) => !o && setShown(null)} title="Temporary password" description={shown?.name} size="sm" footer={<Button onClick={() => setShown(null)}>Done</Button>}>
        <p className="text-sm text-fg-2">Share this privately (in person or by phone). They’ll be asked to choose their own password when they first sign in.</p>
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-surface-2 p-3 font-mono text-lg tracking-wide">
          <span className="flex-1 select-all">{shown?.password}</span>
          <Button size="icon-sm" variant="ghost" aria-label="Copy" icon={<Copy />} onClick={() => shown && navigator.clipboard.writeText(shown.password).then(() => toast.success('Copied'))} />
        </div>
      </Modal>
    </Page>
  );
}

function RoleModal({ u, onClose, roles }: { u: UserProfile | null; onClose: () => void; roles: RoleDef[] }) {
  const [role, setRole] = useState<string>('member');
  const [last, setLast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (u && u.id !== last) {
    setLast(u.id);
    setRole(u.role);
  }
  async function save() {
    if (!u) return;
    const def = roles.find((r) => r.key === role);
    setBusy(true);
    try {
      await patchDoc('users', u.id, { role }, { audit: `Changed ${u.fullName}'s role to ${def?.label ?? role}` });
      toast.success(`${u.fullName} is now ${def?.label ?? role}`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={!!u} onOpenChange={(o) => !o && onClose()} title="Change role" description={u?.fullName} size="sm" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={role === u?.role}>Save</Button></>}>
      <div className="space-y-2">
        {roles.map((r) => (
          <label key={r.key} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${role === r.key ? 'border-brand-500 bg-accent-soft' : 'border-line hover:bg-surface-2'}`}>
            <input type="radio" name="role" className="mt-1 accent-[var(--color-accent)]" checked={role === r.key} onChange={() => setRole(r.key)} />
            <span className="min-w-0"><span className="flex items-center gap-1.5 text-sm font-medium">{r.label}{PROTECTED_ROLES.includes(r.key) && <Lock className="size-3 text-fg-3" />}</span><span className="block text-xs text-fg-3">{r.description || `${r.permissions.length} permissions`}</span></span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

/** Creates the account on the server (Edge Function) so the admin stays signed in. */
function CreateStaff({ open, onOpenChange, roles, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; roles: RoleDef[]; onCreated: (name: string, password: string) => void }) {
  const [f, setF] = useState({ fullName: '', email: '', phone: '', role: 'secretary' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setError('');
    if (!f.fullName.trim()) return setError('Enter their name.');
    if (!f.email.includes('@') && !isValidPhone(f.phone)) return setError('Enter an email address or a valid phone number — they’ll use it to sign in.');
    if (f.phone && !isValidPhone(f.phone)) return setError('Invalid phone number.');
    setBusy(true);
    const password = tempPassword();
    try {
      await api('/v1/admin/users', { method: 'POST', json: { fullName: f.fullName.trim(), email: f.email.trim() || undefined, phone: f.phone || undefined, role: f.role, password } });
      invalidate('users');
      onCreated(f.fullName.trim(), password);
      setF({ fullName: '', email: '', phone: '', role: 'secretary' });
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Add a staff account" description="For pastors, secretaries, treasurers, ushers and other leaders. Members don’t need this — they just complete their profile in the app." footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save} loading={busy}>Create account</Button></>}>
      <div className="space-y-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <TextField label="Full name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} hint="Or leave empty to sign in by phone" />
          <TextField label="Phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </div>
        <Field label="Role">
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {roles.map((r) => <option key={r.key} value={r.key}>{r.label}{r.description ? ` — ${r.description}` : ''}</option>)}
          </Select>
        </Field>
        <p className="text-xs text-fg-3">A temporary password is generated for you to share. They choose their own at first sign-in.</p>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Roles                                                               */
/* ------------------------------------------------------------------ */

const TONES: BadgeTone[] = ['neutral', 'brand', 'info', 'success', 'warning', 'gold', 'danger'];

function RolesPanel({ roles, users, canEdit, myPerms }: { roles: RoleDef[]; users: UserProfile[]; canEdit: boolean; myPerms: string[] }) {
  const [edit, setEdit] = useState<RoleDef | 'new' | null>(null);
  const confirm = useConfirm();
  const count = (k: string) => users.filter((u) => u.role === k).length;
  async function del(r: RoleDef) {
    if (!(await confirm({ title: `Delete the “${r.label}” role?`, description: count(r.key) ? 'Move the people in this role to another role first.' : 'This cannot be undone.', danger: true, confirmLabel: 'Delete role' }))) return;
    const { error } = await supabase.from('roles').delete().eq('key', r.key);
    if (error) return toast.error(error.message.includes('Move the people') ? error.message : 'Could not delete this role');
    invalidate('roles');
    toast.success('Role deleted');
  }
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-fg-2">Each role is a set of permissions. Add roles for your church’s structure — e.g. <em>Ushering lead</em>, <em>Media team</em>, <em>Welfare committee</em>. Nobody can grant powers they don’t hold themselves, and only a super admin can create another super admin.</p>
        {canEdit && <Button size="sm" icon={<Plus />} onClick={() => setEdit('new')}>New role</Button>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {roles.map((r) => (
          <div key={r.key} className="card flex flex-col p-4">
            <div className="flex items-start justify-between gap-2">
              <Badge tone={(r.tone as BadgeTone) || 'neutral'}>{r.label}</Badge>
              <span className="text-xs text-fg-3">{count(r.key)} {count(r.key) === 1 ? 'person' : 'people'}</span>
            </div>
            <p className="mt-2 flex-1 text-sm text-fg-2">{r.description || '—'}</p>
            <p className="mt-2 text-xs text-fg-3">{r.permissions.length ? `${r.permissions.length} permissions` : 'Member app only'}{r.isSystem ? ' · built-in' : ' · custom'}</p>
            {canEdit && !['super_admin', 'developer', 'member'].includes(r.key) && (
              <div className="mt-3 flex gap-2">
                <Button size="xs" variant="outline" icon={<Pencil />} onClick={() => setEdit(r)}>Edit</Button>
                {!r.isSystem && <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => del(r)}>Delete</Button>}
              </div>
            )}
          </div>
        ))}
      </div>
      <RoleEditor role={edit} onClose={() => setEdit(null)} myPerms={myPerms} />
    </>
  );
}

function RoleEditor({ role, onClose, myPerms }: { role: RoleDef | 'new' | null; onClose: () => void; myPerms: string[] }) {
  const isNew = role === 'new';
  const [f, setF] = useState({ label: '', description: '', tone: 'neutral', permissions: [] as string[] });
  const [last, setLast] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (role !== last) {
    setLast(role);
    if (role === 'new') setF({ label: '', description: '', tone: 'neutral', permissions: ['dashboard.view'] });
    else if (role) setF({ label: role.label, description: role.description, tone: role.tone, permissions: role.permissions });
  }
  const toggle = (p: string) => setF((x) => ({ ...x, permissions: x.permissions.includes(p) ? x.permissions.filter((y) => y !== p) : [...x.permissions, p] }));
  async function save() {
    if (!f.label.trim()) return toast.error('Give the role a name');
    setBusy(true);
    try {
      if (isNew) {
        const key = f.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'r_$1').slice(0, 30) || `role_${Date.now()}`;
        const { error } = await supabase.from('roles').insert({ key, label: f.label.trim(), description: f.description.trim(), tone: f.tone, permissions: f.permissions, sort: 50 });
        if (error) throw new Error(error.code === '23505' ? 'A role with this name already exists' : error.message);
        invalidate('roles');
        toast.success(`Role “${f.label}” created`);
      } else if (role) {
        const { data, error } = await supabase.from('roles').update({ label: f.label.trim(), description: f.description.trim(), tone: f.tone, permissions: f.permissions }).eq('key', role.key).select('key');
        if (error) throw new Error(error.message);
        if (!data?.length) throw new Error('You don’t have permission to edit roles');
        invalidate('roles', 'users');
        toast.success('Role updated');
      }
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={!!role} onOpenChange={(o) => !o && onClose()} title={isNew ? 'New role' : `Edit ${f.label}`} side footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy}>{isNew ? 'Create role' : 'Save'}</Button></>}>
      <div className="space-y-5">
        <TextField label="Role name" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} maxLength={60} placeholder="e.g. Media team" />
        <Field label="Description"><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What this role is for" /></Field>
        <Field label="Colour">
          <div className="flex flex-wrap gap-2">
            {TONES.map((t) => (
              <button key={t} type="button" onClick={() => setF({ ...f, tone: t })} className={`rounded-full ring-offset-2 ring-offset-surface ${f.tone === t ? 'ring-2 ring-brand-500' : ''}`}>
                <Badge tone={t}>{t}</Badge>
              </button>
            ))}
          </div>
        </Field>
        <div className="space-y-4">
          {PERMISSION_GROUPS.map((g) => (
            <fieldset key={g.label}>
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-3">{g.label}</legend>
              <div className="space-y-1.5">
                {g.items.map((p) => {
                  const held = myPerms.includes(p.key);
                  return (
                    <label key={p.key} className={`flex items-start gap-3 rounded-lg px-2 py-1.5 ${held ? 'cursor-pointer hover:bg-surface-2' : 'opacity-50'}`}>
                      <Checkbox className="mt-0.5" checked={f.permissions.includes(p.key)} disabled={!held} onChange={() => toggle(p.key)} />
                      <span className="text-sm">{p.label}{!held && <span className="block text-xs text-fg-3">You can’t grant this</span>}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      </div>
    </Modal>
  );
}

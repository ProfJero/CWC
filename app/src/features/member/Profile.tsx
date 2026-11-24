import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Camera, Bell, MessageSquareOff, Moon, Download, KeyRound, LogOut, Phone, Mail, MessageCircle, ChevronRight, LayoutDashboard, Pencil, Users, CalendarCheck2, Loader2, ShieldCheck, LogIn, Trash2, HandHeart, HeartHandshake } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth, signOut, isPhoneLogin, secureAccount, changePassword, authErrorMessage, loginEmailFor } from '@/lib/auth';
import { useChurch } from '@/lib/settings';
import { useGroups, useMember, useMemberAttendance } from '@/lib/queries';
import { patchDoc } from '@/lib/db';
import { supabase } from '@/lib/supabase';
import { api } from '@/lib/api';
import { ProfileForm } from '@/components/profile-prompt';
import { useConfirm } from '@/components/ui/confirm';
import { cloudinaryConfigured, uploadToCloudinary } from '@/lib/media';
import { enablePush, disablePush, getPushState, type PushState } from '@/lib/push';
import { useInstallPrompt } from '@/lib/pwa';
import { formatPhone, isValidPhone, normalizePhone, telHref, whatsappHref } from '@/lib/phone';
import { fmtDate } from '@/lib/format';
import { roleMeta } from '@/lib/permissions';
import { STATUS_META } from '@/lib/members';
import { Avatar } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Switch, TextField } from '@/components/ui/input';
import { Modal } from '@/components/ui/dialog';
import { Banner } from '@/components/ui/feedback';
import { ThemeSwitcher } from '@/components/user-menu';
import { Signature } from '@/components/brand';
import { MemberPage, SectionTitle } from './ui';

function Row({ icon, label, hint, action, onClick, to, danger }: { icon: React.ReactNode; label: string; hint?: string; action?: React.ReactNode; onClick?: () => void; to?: string; danger?: boolean }) {
  const inner = (
    <>
      <span className={`grid size-9 shrink-0 place-items-center rounded-xl [&_svg]:size-[18px] ${danger ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-fg-2'}`}>{icon}</span>
      <span className="min-w-0 flex-1"><span className={`block text-[15px] font-medium ${danger ? 'text-danger' : ''}`}>{label}</span>{hint && <span className="block text-xs text-fg-3">{hint}</span>}</span>
      {action ?? ((onClick || to) && <ChevronRight className="size-4 text-fg-3" />)}
    </>
  );
  const cls = 'flex w-full items-center gap-3 px-4 py-3 text-left';
  if (to) return <Link to={to} className={cls}>{inner}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className={`${cls} active:bg-surface-2`}>{inner}</button>;
  return <div className={cls}>{inner}</div>;
}

export default function Profile() {
  const { profile, user, staff, guest, hasProfile } = useAuth();
  const confirm = useConfirm();
  const church = useChurch();
  const navigate = useNavigate();
  const install = useInstallPrompt();
  const { data: member } = useMember(profile?.memberId);
  const { data: groups } = useGroups();
  const { data: attendance } = useMemberAttendance(profile?.memberId);
  const [push, setPush] = useState<PushState | null>(null);
  const [uploading, setUploading] = useState(false);
  const [edit, setEdit] = useState(false);
  const [pw, setPw] = useState(false);
  const [secure, setSecure] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getPushState().then(setPush).catch(() => setPush('unsupported'));
  }, []);

  if (!profile || !user || !hasProfile) {
    return (
      <MemberPage title="Welcome" subtitle="Use the app freely. Introduce yourself to RSVP, ask for prayer, check in at church and see your giving.">
        <div className="mx-auto grid max-w-3xl grid-cols-1 gap-4 md:grid-cols-5 [&>*]:min-w-0">
          <Card className="p-5 md:col-span-3">
            <ProfileForm />
          </Card>
          <div className="space-y-3 md:col-span-2">
            <Card className="p-5">
              <LogIn className="size-5 text-fg-3" />
              <p className="mt-2 font-semibold">Already part of CWC online?</p>
              <p className="mt-1 text-sm text-fg-3">Sign in with your phone number or email to pick up where you left off.</p>
              <ButtonLink to="/login?next=/me" variant="outline" size="sm" className="mt-3">Sign in</ButtonLink>
            </Card>
            <Card className="divide-y divide-line">
              <Row icon={<Moon />} label="Appearance" action={<ThemeSwitcher className="w-32" />} />
              {(install.canInstall || install.iosHint) && <Row icon={<Download />} label="Install the app" hint={install.canInstall ? 'Works offline, opens from your home screen' : 'Share → Add to Home Screen'} onClick={install.canInstall ? install.install : undefined} />}
            </Card>
          </div>
        </div>
      </MemberPage>
    );
  }
  const myGroups = groups.filter((g) => member?.groupIds?.includes(g.id));

  async function changePhoto(f?: File) {
    if (!f) return;
    setUploading(true);
    try {
      const url = await uploadToCloudinary(f, 'avatars');
      await patchDoc('users', profile!.id, { photoUrl: url });
      if (member) await patchDoc('members', member.id, { photoUrl: url }).catch(() => {});
      toast.success('Photo updated');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function togglePush(on: boolean) {
    try {
      setPush(on ? await enablePush() : await disablePush());
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <MemberPage>
      <div className="flex flex-col items-center text-center">
        <div className="relative">
          <Avatar name={profile.fullName} src={profile.photoUrl} size="2xl" className="ring-4 ring-surface" />
          {cloudinaryConfigured() && (
            <button type="button" onClick={() => file.current?.click()} aria-label="Change photo" className="absolute bottom-0 right-0 grid size-10 place-items-center rounded-full border-4 border-bg bg-accent text-accent-fg">
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
            </button>
          )}
          <input ref={file} type="file" accept="image/*" className="hidden" onChange={(e) => changePhoto(e.target.files?.[0])} />
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">{profile.fullName}</h1>
        <p className="mt-0.5 text-sm text-fg-3">{[formatPhone(profile.phone), profile.email && !isPhoneLogin(profile.email) ? profile.email : ''].filter(Boolean).join(' · ')}</p>
        <div className="mt-2 flex flex-wrap justify-center gap-1.5">
          {member && <Badge tone={STATUS_META[member.membershipStatus]?.tone}>{STATUS_META[member.membershipStatus]?.label}</Badge>}
          {staff && <Badge tone={roleMeta(profile.role, profile.roleDef ? [profile.roleDef] : undefined).tone}>{roleMeta(profile.role, profile.roleDef ? [profile.roleDef] : undefined).label}</Badge>}
          {member && !member.verified && <Badge tone="gold">Welcome — pending confirmation</Badge>}
        </div>
        <div className="mt-4 flex gap-2">
          <Button size="sm" variant="outline" icon={<Pencil />} onClick={() => setEdit(true)}>Edit profile</Button>
          {staff && <ButtonLink to="/admin" size="sm" icon={<LayoutDashboard />}>Church admin</ButtonLink>}
        </div>
      </div>

      {member ? (
        <>
          <SectionTitle>My church life</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            <Card className="p-4"><CalendarCheck2 className="size-5 text-fg-3" /><p className="mt-2 text-xl font-semibold">{attendance.length}</p><p className="text-xs text-fg-3">check-ins recorded</p></Card>
            <Card className="p-4"><Users className="size-5 text-fg-3" /><p className="mt-2 text-xl font-semibold">{myGroups.length}</p><p className="text-xs text-fg-3">{myGroups.length === 1 ? 'group' : 'groups'}</p></Card>
          </div>
          {myGroups.length > 0 && (
            <Card className="mt-3 divide-y divide-line">
              {myGroups.map((g) => (
                <div key={g.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="font-medium">{g.name}</span>
                  <span className="text-xs text-fg-3">{[g.meetingDay, g.meetingTime].filter(Boolean).join(' · ')}</span>
                </div>
              ))}
            </Card>
          )}
          <p className="mt-2 text-xs text-fg-3">Member since {fmtDate(member.joinDate, 'MMMM yyyy')}</p>
        </>
      ) : (
        <Banner tone="brand" className="mt-6">Ask the church office to link your account to your member record to see your groups, attendance and giving.</Banner>
      )}

      {guest && (
        <Card className="mt-6 flex items-start gap-3 border-gold-200 p-4 dark:border-gold-500/25">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-gold-600" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Use CWC on another phone?</p>
            <p className="mt-0.5 text-sm text-fg-3">You’re signed in on this device only. Choose a password to sign in anywhere with {formatPhone(profile.phone) || 'your phone number'}.</p>
            <Button size="sm" className="mt-3" onClick={() => setSecure(true)}>Set a password</Button>
          </div>
        </Card>
      )}

      <SectionTitle>Quick links</SectionTitle>
      <Card className="divide-y divide-line">
        <Row icon={<HandHeart />} label="My giving" hint="History and statements" to="/give" />
        <Row icon={<HeartHandshake />} label="My requests" hint="Prayer, counselling and visits" to="/care" />
        <Row icon={<Bell />} label="Notifications" to="/notifications" />
      </Card>

      <SectionTitle>Preferences</SectionTitle>
      <Card className="divide-y divide-line">
        <Row icon={<Bell />} label="Push notifications" hint={push === 'denied' ? 'Blocked in browser settings' : push === 'unsupported' ? 'Not supported on this browser' : 'Devotionals, events and replies'} action={<Switch checked={push === 'subscribed'} onCheckedChange={togglePush} disabled={push === 'denied' || push === 'unsupported' || push === null} />} />
        {member && <Row icon={<MessageSquareOff />} label="Bulk SMS" hint="Church-wide text messages" action={<Switch checked={!member.smsOptOut} onCheckedChange={(v) => patchDoc('members', member.id, { smsOptOut: !v })} />} />}
        <Row icon={<Moon />} label="Appearance" action={<ThemeSwitcher className="w-32" />} />
        {(install.canInstall || install.iosHint) && <Row icon={<Download />} label="Install the app" hint={install.canInstall ? 'Works offline, opens from your home screen' : 'Share → Add to Home Screen'} onClick={install.canInstall ? install.install : undefined} />}
        {guest ? <Row icon={<KeyRound />} label="Set a password" hint="Sign in on other devices" onClick={() => setSecure(true)} /> : <Row icon={<KeyRound />} label="Change password" onClick={() => setPw(true)} />}
      </Card>

      <SectionTitle>Contact the church</SectionTitle>
      <Card className="divide-y divide-line">
        {church.phone && <Row icon={<Phone />} label="Call the office" hint={formatPhone(church.phone)} onClick={() => (location.href = telHref(church.phone)!)} />}
        {church.phone && <Row icon={<MessageCircle />} label="WhatsApp" onClick={() => window.open(whatsappHref(church.phone), '_blank')} />}
        {church.email && <Row icon={<Mail />} label="Email" hint={church.email} onClick={() => (location.href = `mailto:${church.email}`)} />}
      </Card>

      <SectionTitle>Account</SectionTitle>
      <Card className="divide-y divide-line">
        <Row icon={<LogOut />} label="Sign out" danger onClick={async () => {
          if (guest && !(await confirm({ title: 'Sign out of this device?', description: 'You haven’t set a password yet, so you won’t be able to sign back in. Set a password first, or the church office can help later.', danger: true, confirmLabel: 'Sign out anyway' }))) return;
          await signOut();
          navigate('/', { replace: true });
        }} />
        <Row icon={<Trash2 />} label="Delete my account" hint="Removes your login. Your church record stays with the office." danger onClick={async () => {
          if (!(await confirm({ title: 'Delete your account?', description: 'You will be signed out and can no longer sign in with it. This cannot be undone.', danger: true, confirmLabel: 'Delete account' }))) return;
          try {
            await api('/v1/me/account', { method: 'DELETE' });
            await signOut();
            navigate('/', { replace: true });
            toast.success('Your account has been deleted');
          } catch (e) {
            toast.error((e as Error).message);
          }
        }} />
      </Card>

      <div className="mt-8 flex flex-col items-center gap-1 pb-4 text-center">
        <p className="text-xs text-fg-3">{church.name} · v{__APP_VERSION__}</p>
        <Signature />
      </div>

      <EditProfile open={edit} onOpenChange={setEdit} />
      <ChangePassword open={pw} onOpenChange={setPw} />
      <SecureAccount open={secure} onOpenChange={setSecure} />
    </MemberPage>
  );
}

function EditProfile({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { profile } = useAuth();
  const { data: member } = useMember(profile?.memberId);
  const [f, setF] = useState({ fullName: '', phone: '', address: '', gpsAddress: '', occupation: '', dob: '', emergencyName: '', emergencyPhone: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open && profile) setF({ fullName: profile.fullName, phone: profile.phone ? '0' + profile.phone.slice(3) : '', address: member?.address ?? '', gpsAddress: member?.gpsAddress ?? '', occupation: member?.occupation ?? '', dob: member?.dob ?? '', emergencyName: member?.emergencyName ?? '', emergencyPhone: member?.emergencyPhone ? '0' + member.emergencyPhone.slice(3) : '' });
  }, [open, profile, member]);
  const bind = (k: keyof typeof f) => ({ value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value })) });
  async function save() {
    if (!f.fullName.trim()) return toast.error('Name is required');
    if (f.phone && !isValidPhone(f.phone)) return toast.error('Enter a valid phone number');
    setBusy(true);
    try {
      await patchDoc('users', profile!.id, { fullName: f.fullName.trim(), phone: normalizePhone(f.phone) });
      if (member) {
        await patchDoc('members', member.id, { fullName: f.fullName.trim(), phone: normalizePhone(f.phone) || member.phone, address: f.address, gpsAddress: f.gpsAddress, occupation: f.occupation, dob: f.dob, emergencyName: f.emergencyName, emergencyPhone: normalizePhone(f.emergencyPhone) });
      }
      toast.success('Profile updated');
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Edit profile" footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save} loading={busy}>Save</Button></>}>
      <div className="space-y-4">
        <TextField label="Full name" {...bind('fullName')} />
        <TextField label="Phone" type="tel" {...bind('phone')} />
        {member && (
          <>
            <TextField label="Date of birth" type="date" {...bind('dob')} hint="So the church can celebrate your birthday" />
            <TextField label="Residential address" {...bind('address')} />
            <TextField label="GhanaPost GPS" placeholder="GA-123-4567" {...bind('gpsAddress')} />
            <TextField label="Occupation" {...bind('occupation')} />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Emergency contact" {...bind('emergencyName')} />
              <TextField label="Their phone" type="tel" {...bind('emergencyPhone')} />
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function ChangePassword({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    const email = (await supabase.auth.getUser()).data.user?.email;
    if (!email || next.length < 8) return toast.error('New password must be at least 8 characters');
    setBusy(true);
    try {
      await changePassword(email, current, next);
      toast.success('Password changed');
      setCurrent('');
      setNext('');
      onOpenChange(false);
    } catch (e) {
      toast.error(authErrorMessage(e).includes('match') ? 'Current password is incorrect' : authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Change password" size="sm" footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save} loading={busy}>Update</Button></>}>
      <div className="space-y-4">
        <TextField label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <TextField label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
    </Modal>
  );
}

function SecureAccount({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { profile, refresh } = useAuth();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (pw.length < 8) return toast.error('Use at least 8 characters');
    setBusy(true);
    try {
      await secureAccount(pw);
      await refresh();
      toast.success('Password set', { description: `Sign in anywhere with ${formatPhone(profile?.phone) || 'your phone number'}.` });
      setPw('');
      onOpenChange(false);
    } catch (e) {
      toast.error(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Set a password" description={`You’ll sign in with ${profile?.phone ? formatPhone(profile.phone) : 'your phone number'} and this password.`} size="sm" footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save} loading={busy}>Save password</Button></>}>
      <TextField label="Password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} hint="At least 8 characters" autoFocus />
      <input type="hidden" autoComplete="username" value={loginEmailFor(profile?.phone ?? '')} readOnly />
    </Modal>
  );
}

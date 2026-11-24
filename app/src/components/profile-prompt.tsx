import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

import { HeartHandshake, ShieldCheck, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { completeProfile, useAuth, type ProfileInput } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { isValidPhone, formatPhone } from '@/lib/phone';
import { cn } from '@/lib/utils';
import { Modal } from './ui/dialog';
import { Button } from './ui/button';
import { Field, Input, Select, TextField } from './ui/input';
import { Banner } from './ui/feedback';

/**
 * "Complete your profile" — the member app works without signing up. When someone wants to do
 * something personal (RSVP, prayer request, check in, see their giving), we ask for a few details
 * once so the church knows them. Behind the scenes a private device account is created.
 */

type Ask = (reason?: string) => Promise<boolean>;
const Ctx = createContext<Ask>(async () => false);

export function useRequireProfile(): Ask {
  return useContext(Ctx);
}

export function ProfilePromptProvider({ children }: { children: ReactNode }) {
  const { user, hasProfile } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | undefined>();
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback<Ask>(
    (why) => {
      if (user && hasProfile) return Promise.resolve(true);
      setReason(why);
      setOpen(true);
      return new Promise<boolean>((res) => {
        resolver.current = res;
      });
    },
    [user, hasProfile],
  );

  function finish(ok: boolean) {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  }

  return (
    <Ctx.Provider value={ask}>
      {children}
      <Modal open={open} onOpenChange={(o) => !o && finish(false)} title="Tell us who you are" description={reason ? `So we can ${reason}.` : 'So the church family can get to know you.'} size="sm">
        <ProfileForm onDone={() => finish(true)} compact />
      </Modal>
    </Ctx.Provider>
  );
}

const STATUS_OPTIONS = [
  { value: 'first_timer', label: 'I’m visiting for the first time' },
  { value: 'visitor', label: 'I’ve visited before' },
  { value: 'member', label: 'I’m a member of CWC' },
  { value: 'new_convert', label: 'I just gave my life to Christ' },
] as const;

export function ProfileForm({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const { user, profile, refresh } = useAuth();
  const [first, ...rest] = (profile?.fullName ?? '').split(' ');
  const [f, setF] = useState<ProfileInput>({
    firstName: first ?? '',
    lastName: rest.join(' '),
    phone: profile?.phone ? formatPhone(profile.phone) : '',
    email: profile?.email ?? '',
    gender: '',
    dob: '',
    membershipStatus: 'first_timer',
  });
  const [more, setMore] = useState(!compact);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; exists?: boolean } | null>(null);
  const [touched, setTouched] = useState(false);
  const set = <K extends keyof ProfileInput>(k: K, v: ProfileInput[K]) => setF((x) => ({ ...x, [k]: v }));

  const errors = {
    firstName: !f.firstName.trim() ? 'Required' : '',
    lastName: !f.lastName.trim() ? 'Required' : '',
    phone: !isValidPhone(f.phone) ? 'Enter a valid phone number, e.g. 024 123 4567' : '',
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (errors.firstName || errors.lastName || errors.phone) return;
    setBusy(true);
    setError(null);
    try {
      await completeProfile(f, { signedIn: !!user });
      await refresh();
      toast.success(`Welcome, ${f.firstName.trim()}! 🎉`, { description: 'Thank you — the church office now knows you.' });
      onDone?.();
    } catch (err) {
      const exists = err instanceof ApiError && err.status === 409;
      setError({ text: (err as Error).message, exists });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {!compact && (
        <div className="flex items-start gap-3 rounded-2xl bg-accent-soft p-4 text-sm">
          <Sparkles className="mt-0.5 size-5 shrink-0 text-accent dark:text-brand-300" />
          <p className="text-accent-soft-fg">No account or password needed — just a few details so we can welcome you, pray with you and keep you updated.</p>
        </div>
      )}
      {error && (
        <Banner tone={error.exists ? 'warning' : 'danger'} action={error.exists && <a href="/login" className="text-sm font-semibold underline">Sign in</a>}>
          {error.text}
        </Banner>
      )}
      <div className="grid grid-cols-2 gap-3">
        <TextField label="First name" autoComplete="given-name" value={f.firstName} onChange={(e) => set('firstName', e.target.value)} error={touched ? errors.firstName : ''} autoFocus />
        <TextField label="Last name" autoComplete="family-name" value={f.lastName} onChange={(e) => set('lastName', e.target.value)} error={touched ? errors.lastName : ''} />
      </div>
      <TextField label="Phone number" type="tel" inputMode="tel" autoComplete="tel" placeholder="024 123 4567" value={f.phone} onChange={(e) => set('phone', e.target.value)} error={touched ? errors.phone : ''} hint="The church may call or text you. We never share it." />
      <Field label="Which describes you?">
        <div className="grid gap-2">
          {STATUS_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => set('membershipStatus', o.value)}
              className={cn('flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors', f.membershipStatus === o.value ? 'border-brand-500 bg-accent-soft ring-1 ring-brand-500' : 'border-line hover:bg-surface-2')}
            >
              <span className={cn('size-4 shrink-0 rounded-full border-2', f.membershipStatus === o.value ? 'border-brand-500 bg-brand-500 shadow-[inset_0_0_0_2px_var(--color-surface)]' : 'border-line-strong')} />
              {o.label}
            </button>
          ))}
        </div>
      </Field>
      {more ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Email (optional)" type="email" autoComplete="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
          <Field label="Gender (optional)">
            <Select value={f.gender} onChange={(e) => set('gender', e.target.value as ProfileInput['gender'])}>
              <option value="">Prefer not to say</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </Select>
          </Field>
          <Field label="Birthday (optional)" hint="So we can celebrate you">
            <Input type="date" value={f.dob} max={new Date().toISOString().slice(0, 10)} onChange={(e) => set('dob', e.target.value)} />
          </Field>
          <TextField label="How did you hear about us?" value={f.howHeard ?? ''} onChange={(e) => set('howHeard', e.target.value)} placeholder="Friend, social media, passing by…" />
        </div>
      ) : (
        <button type="button" className="text-sm font-medium text-accent hover:underline dark:text-brand-300" onClick={() => setMore(true)}>
          + Add birthday, email and more (optional)
        </button>
      )}
      <Button type="submit" size="lg" className="w-full" loading={busy} icon={<HeartHandshake />}>
        Continue
      </Button>
      <p className="flex items-center justify-center gap-1.5 text-center text-xs text-fg-3">
        <ShieldCheck className="size-3.5" /> Seen only by church leaders. {!user && <>Have an account? <a href="/login" className="font-medium text-accent dark:text-brand-300">Sign in</a></>}
      </p>
    </form>
  );
}

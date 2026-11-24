import { useState, type FormEvent } from 'react';
import { KeyRound, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { authErrorMessage, signOut, useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { useDocumentTitle } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/input';
import { Banner } from '@/components/ui/feedback';
import { CwcLogo } from '@/components/brand';

/** Shown once after signing in with a temporary password (new staff accounts, admin resets). */
export default function ForcePasswordChange() {
  useDocumentTitle('Choose a password');
  const { profile, refresh } = useAuth();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw.length < 8) return setError('Use at least 8 characters.');
    if (pw !== pw2) return setError('The two passwords don’t match.');
    setBusy(true);
    setError('');
    try {
      const { error: err } = await supabase.auth.updateUser({ password: pw });
      if (err) throw err;
      await supabase.from('users').update({ must_change_password: false }).eq('id', profile!.id);
      await refresh();
      toast.success('Password updated — welcome!');
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-5 py-10">
      <form onSubmit={submit} className="card w-full max-w-sm p-6 sm:p-8" noValidate>
        <CwcLogo className="mb-6 w-14 text-brand-800 dark:text-brand-300" />
        <h1 className="text-xl font-semibold tracking-tight">Choose your own password</h1>
        <p className="mt-1.5 text-sm text-fg-3">Hi {profile?.fullName?.split(' ')[0] || 'there'} — you signed in with a temporary password. Please set a private one to continue.</p>
        <div className="mt-6 space-y-4">
          {error && <Banner tone="danger">{error}</Banner>}
          <TextField label="New password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} hint="At least 8 characters" autoFocus />
          <TextField label="Confirm password" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          <Button type="submit" size="lg" className="w-full" icon={<KeyRound />} loading={busy}>Save password</Button>
          <Button type="button" variant="ghost" className="w-full" icon={<LogOut />} onClick={() => signOut()}>Sign out</Button>
        </div>
      </form>
    </div>
  );
}

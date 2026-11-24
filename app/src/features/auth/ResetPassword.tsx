import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { authErrorMessage } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { useDocumentTitle } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/input';
import { Banner } from '@/components/ui/feedback';

/** Landing page for the email reset link (Supabase signs the person in with a recovery session). */
export default function ResetPassword() {
  useDocumentTitle('Set a new password');
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') setReady(true);
    });
    void supabase.auth.getSession().then(({ data: d }) => d.session && setReady(true));
    return () => data.subscription.unsubscribe();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw.length < 8) return setError('Use at least 8 characters.');
    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (err) return setError(authErrorMessage(err));
    toast.success('Password updated');
    navigate('/', { replace: true });
  }

  return (
    <div className="animate-slide-up">
      <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
      {!ready ? (
        <p className="mt-3 text-sm text-fg-3">Checking your reset link… If nothing happens, the link may have expired. <Link to="/forgot" className="font-medium text-accent dark:text-brand-300">Request a new one</Link>.</p>
      ) : (
        <form onSubmit={submit} className="mt-8 space-y-4" noValidate>
          {error && <Banner tone="danger">{error}</Banner>}
          <TextField label="New password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          <Button type="submit" size="lg" className="w-full" loading={busy}>Save password</Button>
        </form>
      )}
    </div>
  );
}

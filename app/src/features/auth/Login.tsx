import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Eye, EyeOff } from 'lucide-react';
import { authErrorMessage, signIn } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/input';
import { Banner } from '@/components/ui/feedback';
import { useDocumentTitle } from '@/lib/hooks';

export default function Login() {
  useDocumentTitle('Sign in');
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [params] = useSearchParams();
  const navigate = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await signIn(id, password);
      const next = params.get('next');
      // GuestOnly redirects based on role once the profile loads.
      if (next?.startsWith('/')) navigate(next, { replace: true });
    } catch (err) {
      setError(authErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="animate-slide-up">
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-1.5 text-sm text-fg-3">Sign in with your email or phone number.</p>
      <form onSubmit={submit} className="mt-8 space-y-4" noValidate>
        {error && <Banner tone="danger">{error}</Banner>}
        <TextField
          label="Email or phone"
          name="username"
          autoComplete="username"
          inputMode="email"
          placeholder="you@example.com or 024 123 4567"
          value={id}
          onChange={(e) => setId(e.target.value)}
          required
          autoFocus
        />
        <div>
          <TextField
            label="Password"
            name="password"
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <div className="mt-2 flex items-center justify-between">
            <button type="button" onClick={() => setShow((s) => !s)} className="inline-flex items-center gap-1.5 text-xs font-medium text-fg-3 hover:text-fg">
              {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {show ? 'Hide' : 'Show'} password
            </button>
            <Link to="/forgot" className="text-xs font-medium text-accent hover:underline dark:text-brand-300">
              Forgot password?
            </Link>
          </div>
        </div>
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!id || !password}>
          Sign in
        </Button>
      </form>
      <div className="mt-8 space-y-3 text-center text-sm text-fg-3">
        <p>
          New here?{' '}
          <Link to="/signup" className="font-medium text-accent hover:underline dark:text-brand-300">
            Create an account
          </Link>
        </p>
        <p>
          <Link to="/" className="font-medium text-fg-2 underline-offset-4 hover:underline">
            Continue without an account →
          </Link>
        </p>
      </div>
    </div>
  );
}

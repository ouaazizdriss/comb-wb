import { useEffect, useState } from 'react';
import { api, setCsrf } from '../lib/api.ts';
import { Button, TextInput, Label, ErrorBox } from '../ui/index.tsx';
import { CombMark } from './App.tsx';

function Frame({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', justifyContent: 'center', padding: '12vh 24px 40px' }}>
      <div style={{ width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <CombMark />
          <div style={{ fontSize: 20, lineHeight: '26px', fontWeight: 600 }}>Comb</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 24, lineHeight: '30px', fontWeight: 600 }}>{title}</div>
          {sub ? <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)' }}>{sub}</div> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, ...rest }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <Label>{label}</Label>
      <TextInput {...rest} style={{ height: 32 }} />
    </label>
  );
}

export function AuthScreen({ mode, sso, onDone }: { mode: 'setup' | 'login' | 'mfa'; sso: { ssoEnabled: boolean; ssoOnly: boolean }; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (mode === 'setup') {
        const r = await api.post('/auth/setup', { email, name, password });
        setCsrf(r.csrfToken);
      } else if (mode === 'login') {
        const r = await api.post('/auth/login', { email, password });
        setCsrf(r.csrfToken);
      } else {
        const r = await api.post('/auth/mfa', { code });
        setCsrf(r.csrfToken);
      }
      setPassword('');
      onDone();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'mfa') {
    return (
      <Frame title="Two-factor code" sub="Enter the 6-digit code from your authenticator app.">
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" autoFocus />
          {err ? <ErrorBox error={err} /> : null}
          <Button variant="primary" size="lg" disabled={busy || code.length !== 6}>Verify</Button>
          <Button type="button" variant="ghost" onClick={async () => { await api.post('/auth/logout').catch(() => {}); location.reload(); }}>Use a different account</Button>
        </form>
      </Frame>
    );
  }

  return (
    <Frame
      title={mode === 'setup' ? 'Create the owner account' : 'Sign in'}
      sub={mode === 'setup' ? 'This is the first account on this Comb server. It owns the workspace and can invite everyone else.' : undefined}
    >
      {sso.ssoEnabled ? (
        <Button variant={sso.ssoOnly ? 'primary' : 'secondary'} size="lg" onClick={() => { location.href = '/api/sso/login'; }}>
          Continue with single sign-on
        </Button>
      ) : null}
      {!sso.ssoOnly || mode === 'setup' ? (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mode === 'setup' ? <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /> : null}
          <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus />
          <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} />
          {mode === 'setup' ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>At least 12 characters. A passphrase is easiest.</div> : null}
          {err ? <ErrorBox error={err} /> : null}
          <Button variant="primary" size="lg" disabled={busy}>{mode === 'setup' ? 'Create account' : 'Sign in'}</Button>
        </form>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>This workspace signs in through your identity provider only.</div>
      )}
    </Frame>
  );
}

/** Shown when policy requires MFA and the user has not enrolled. Uses the security module's endpoints. */
export function MfaEnrollScreen({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    api.post('/security/mfa/setup').then(setSetup).catch(setErr);
  }, []);
  const confirm = async () => {
    try {
      const r = await api.post('/security/mfa/enable', { code });
      if (r?.csrfToken) setCsrf(r.csrfToken);
      onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Frame title="Set up two-factor authentication" sub="Your workspace requires it. Scan the code with an authenticator app, then enter the 6-digit code it shows.">
      {setup ? (
        <>
          {setup.qrDataUrl.startsWith('data:image/png;base64,') ? (
            <img src={setup.qrDataUrl} alt="Authenticator QR code" width={180} height={180} style={{ background: '#fff', padding: 8, borderRadius: 3 }} />
          ) : null}
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{setup.secret}</div>
        </>
      ) : null}
      <Field label="Code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" />
      {err ? <ErrorBox error={err} /> : null}
      <Button variant="primary" size="lg" disabled={code.length !== 6} onClick={confirm}>Turn on two-factor</Button>
    </Frame>
  );
}

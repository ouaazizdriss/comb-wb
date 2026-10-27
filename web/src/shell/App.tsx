import { useEffect, useState } from 'react';
import { api, onAuthProblem, setCsrf } from '../lib/api.ts';
import { useApp, rememberedConnection } from '../lib/store.ts';
import { AuthScreen, MfaEnrollScreen } from './Auth.tsx';
import { Launcher } from './Launcher.tsx';
import { Workspace } from './Workspace.tsx';
import { Overlays } from './Overlays.tsx';
import { Loading } from '../ui/index.tsx';

type Phase = 'loading' | 'setup' | 'login' | 'mfa' | 'enroll' | 'ready';

export function App() {
  const theme = useApp((s) => s.theme);
  const conn = useApp((s) => s.conn);
  const setMe = useApp((s) => s.setMe);
  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState<{ ssoEnabled: boolean; ssoOnly: boolean }>({ ssoEnabled: false, ssoOnly: false });
  const [winW, setWinW] = useState(window.innerWidth);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const r = () => setWinW(window.innerWidth);
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);

  // After a reload, go back to the connection this tab had open; its tabs restore from local storage.
  const reopen = async () => {
    const id = rememberedConnection();
    if (!id || useApp.getState().conn) return;
    try {
      useApp.getState().openConnection(await api.post(`/connections/${id}/open`));
    } catch {
      useApp.getState().closeConnection();
    }
  };

  const boot = async () => {
    try {
      const st = await api.get('/auth/status');
      setStatus(st);
      if (st.needsSetup) return setPhase('setup');
      const me = await api.get('/auth/me');
      setCsrf(me.csrfToken);
      setMe(me);
      if (!me.mfaEnrollRequired) await reopen();
      setPhase(me.mfaEnrollRequired ? 'enroll' : 'ready');
    } catch (e: any) {
      setPhase(e?.body?.mfa ? 'mfa' : 'login');
    }
  };

  useEffect(() => {
    void boot();
    return onAuthProblem((code, body) => {
      if (body?.mfaEnroll) setPhase('enroll');
      else if (code === 401) {
        setMe(null);
        useApp.getState().closeConnection({ keep: true });
        setPhase(body?.mfa ? 'mfa' : 'login');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'loading') return <Loading />;
  if (phase === 'setup' || phase === 'login' || phase === 'mfa') {
    return <AuthScreen mode={phase} sso={status} onDone={boot} />;
  }
  if (phase === 'enroll') return <MfaEnrollScreen onDone={boot} />;

  if (winW < 900) {
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <CombMark />
          <div style={{ fontSize: 20, fontWeight: 600 }}>Comb needs a wider window.</div>
          <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)' }}>
            A data grid, a tree and an editor do not fit in {winW}px. Widen to at least 900px — this is not a phone app, and pretending otherwise would make every other screen worse.
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {conn ? <Workspace /> : <Launcher />}
      <Overlays />
    </>
  );
}

export function CombMark({ size = 22 }: { size?: number }) {
  const b = '1.5px solid var(--text-primary)';
  return (
    <div style={{ width: size, height: size, border: b, borderRadius: 3, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', flex: 'none' }}>
      <div style={{ borderRight: b, borderBottom: b }} />
      <div style={{ borderBottom: b }} />
      <div style={{ borderRight: b }} />
      <div />
    </div>
  );
}

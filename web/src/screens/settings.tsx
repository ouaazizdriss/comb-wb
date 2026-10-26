import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiMode } from '@comb/shared/src/ai.ts';
import { api } from '../lib/api.ts';
import { toastError, useApp, type Tab } from '../lib/store.ts';
import { Loading, Seg, Toggle } from '../ui/index.tsx';
import { KeyField, useAiConfig } from './ai.tsx';
import { useAiStatus } from './ai-panel.tsx';

type Safety = { requireTypedConfirm: boolean; typedConfirmProd: boolean; blockWhereless: boolean; redactLiterals: boolean; canEdit: boolean };
const SAFETY: Array<[keyof Omit<Safety, 'canEdit'>, string, string]> = [
  ['requireTypedConfirm', 'Confirm destructive statements', 'DROP, TRUNCATE and similar ask you to type the object name.'],
  ['typedConfirmProd', 'Typed confirmation on prod connections', 'Every write on a prod connection asks for the connection name.'],
  ['blockWhereless', 'Block UPDATE / DELETE without WHERE', 'Refused before it reaches the database.'],
  ['redactLiterals', 'Redact literal values in query history', 'The audit trail and history store $1, $2… instead of values.'],
];
const CTX = ['Schema only', '+ samples', 'None'] as const;
const toMode = (l: (typeof CTX)[number]): AiMode => (l === '+ samples' ? 'samples' : l === 'None' ? 'none' : 'schema');
const toSeg = (m: AiMode): (typeof CTX)[number] => (m === 'samples' ? '+ samples' : m === 'none' ? 'None' : 'Schema only');

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20 }}>
      <div>
        <div style={{ fontSize: 13, lineHeight: '18px' }}>{label}</div>
        {hint ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}
const Divider = () => <div style={{ height: 1, background: 'var(--border-subtle)' }} />;

/** Settings tab. */
export default function SettingsScreen({ tab }: { tab: Tab }) {
  void tab;
  const theme = useApp((s) => s.theme);
  const density = useApp((s) => s.density);
  const me = useApp((s) => s.me);
  const canReadAi = me?.role === 'Owner' || me?.role === 'Admin' || me?.role === 'Analyst';
  const qc = useQueryClient();

  const { q: aiCfg, save } = useAiConfig(canReadAi);
  const status = useAiStatus();
  const safety = useQuery({ queryKey: ['settings-safety'], queryFn: () => api.get<Safety>('/settings/safety') });
  const setSafety = useMutation({
    mutationFn: (patch: Partial<Safety>) => api.put<Safety>('/settings/safety', patch),
    onSuccess: (d) => qc.setQueryData(['settings-safety'], d),
    onError: (e) => toastError(e, 'Not saved'),
  });

  const cfg = canReadAi ? aiCfg.data : undefined;
  const aiMode: AiMode = cfg?.defaultMode ?? status.data?.defaultMode ?? 'schema';
  const aiEditable = !!cfg?.canEdit;

  return (
    <div className="screen">
      <div style={{ maxWidth: 720, padding: '24px 28px 60px', display: 'flex', flexDirection: 'column', gap: 26 }}>
        <div style={{ fontSize: 20, lineHeight: '26px', fontWeight: 600 }}>Settings</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="label">Appearance</div>
          <Row label="Theme" hint="Dark is the default. Saved in this browser.">
            <Seg options={['Dark', 'Light'] as const} value={theme === 'dark' ? 'Dark' : 'Light'} onChange={(l) => useApp.getState().setTheme(l === 'Dark' ? 'dark' : 'light')} />
          </Row>
          <Row label="Density" hint="Row height in every grid.">
            <Seg options={['Compact', 'Comfortable'] as const} value={density === 'compact' ? 'Compact' : 'Comfortable'} onChange={(l) => useApp.getState().setDensity(l === 'Compact' ? 'compact' : 'comfortable')} />
          </Row>
        </div>
        <Divider />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="label">AI</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 520 }}>
            <div style={{ fontSize: 13, lineHeight: '18px' }}>API key</div>
            {cfg ? <KeyField cfg={cfg} withTest={false} />
              : canReadAi && aiCfg.isLoading ? <Loading />
                : (
                  <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: status.data?.hasKey ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                    {status.data ? (status.data.hasKey ? 'Configured · stored server-side' : 'Not configured') : '…'} · only admins can change it
                  </div>
                )}
          </div>
          <button className="hov" onClick={() => useApp.getState().openTab('ai', 'AI configuration')}
            style={{ alignSelf: 'flex-start', height: 24, padding: '0 10px', border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 12 }}>
            Open full AI configuration →
          </button>
          <Row label="Default context mode" hint={aiEditable ? 'What the panel sends unless you change it.' : 'What the panel sends unless you change it. Set by an admin.'}>
            <div style={{ opacity: aiEditable ? 1 : 0.6, pointerEvents: aiEditable ? undefined : 'none' }} aria-disabled={!aiEditable}>
              <Seg options={CTX} value={toSeg(aiMode)} onChange={(l) => {
                if (l === '+ samples' && cfg?.hardOff) return useApp.getState().toast('Blocked by the hard switch', 'Turn off “Never send row data” in AI configuration first.', 'error');
                save.mutate({ defaultMode: toMode(l) });
              }} />
            </div>
          </Row>
        </div>
        <Divider />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="label">Safety</div>
          {safety.isLoading ? <Loading /> : null}
          {safety.data ? SAFETY.map(([k, label, hint]) => (
            <Row key={k} label={label} hint={hint}>
              <Toggle on={safety.data[k]} disabled={!safety.data.canEdit || setSafety.isPending} title={safety.data.canEdit ? label : 'Only admins can change this'}
                onChange={(v) => setSafety.mutate({ [k]: v })} />
            </Row>
          )) : null}
          {safety.data && !safety.data.canEdit ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>These apply to the whole workspace. Only admins can change them.</div> : null}
          {safety.data?.canEdit ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>These apply to the whole workspace and are enforced by the server. Changes are audited.</div> : null}
        </div>
      </div>
    </div>
  );
}

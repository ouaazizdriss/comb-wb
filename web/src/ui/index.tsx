import React, { useEffect, useRef } from 'react';
import type { Environment } from '@comb/shared';

/*
 * Shared UI kit. Every visual here mirrors a recurring style in docs/mockup/markup.html,
 * so screens should compose these instead of re-inventing buttons, segments and toggles.
 */

export const MONO = 'var(--mono)';
export const COND = 'var(--cond)';
export const IDC: Record<string, string> = {
  slate: '#64748B', azure: '#3B82F6', teal: '#14B8A6', lime: '#84CC16', amber: '#F59E0B', coral: '#F43F5E', violet: '#8B5CF6', fuchsia: '#D946EF',
};
export const TYPE_COLOR: Record<string, string> = {
  numeric: 'var(--type-numeric)', text: 'var(--type-text)', temporal: 'var(--type-temporal)', boolean: 'var(--type-boolean)',
  structured: 'var(--type-structured)', identifier: 'var(--type-identifier)', other: 'var(--type-other)',
};

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';

export function Button({ variant = 'secondary', size = 'md', style, children, ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md' | 'lg' }) {
  const h = size === 'sm' ? 22 : size === 'lg' ? 32 : 26;
  const base: React.CSSProperties = {
    height: h, padding: size === 'sm' ? '0 8px' : '0 12px', borderRadius: 3, fontSize: size === 'sm' ? 12 : 13,
    fontWeight: variant === 'primary' || variant === 'danger' ? 500 : 400, display: 'inline-flex', alignItems: 'center', gap: 6,
    whiteSpace: 'nowrap', flex: 'none',
  };
  const v: Record<BtnVariant, React.CSSProperties> = {
    primary: { background: 'var(--btn-primary)', color: 'var(--text-inverse)' },
    secondary: { border: '1px solid var(--border-strong)', color: 'var(--text-primary)' },
    ghost: { color: 'var(--text-secondary)' },
    danger: { background: 'var(--danger)', color: '#10151A' },
    'danger-ghost': { border: '1px solid color-mix(in oklab, var(--danger) 55%, transparent)', color: 'var(--danger)' },
  };
  return (
    <button className={variant === 'primary' || variant === 'danger' ? undefined : 'hov'} style={{ ...base, ...v[variant], ...style }} {...rest}>
      {children}
    </button>
  );
}

export function IconButton({ title, children, active, style, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      title={title}
      aria-label={title}
      className="hov hov-text"
      style={{ width: 26, height: 26, borderRadius: 3, color: 'var(--text-secondary)', display: 'grid', placeItems: 'center', fontSize: 13, flex: 'none',
        background: active ? 'var(--bg-hover)' : 'transparent', ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Segmented control (mockup "seg"). */
export function Seg<T extends string>({ options, value, onChange, labels }: { options: readonly T[]; value: T; onChange: (v: T) => void; labels?: Partial<Record<T, string>> }) {
  return (
    <div style={{ display: 'flex', border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden', height: 24, flex: 'none' }}>
      {options.map((o, i) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          style={{
            padding: '0 9px', fontSize: 12, fontFamily: COND, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
            background: o === value ? 'var(--bg-selected)' : 'transparent', color: o === value ? 'var(--text-primary)' : 'var(--text-muted)',
            borderRight: i < options.length - 1 ? '1px solid var(--border-subtle)' : 'none', whiteSpace: 'nowrap',
          }}
        >
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, disabled, title }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!on)}
      style={{ width: 34, height: 18, borderRadius: 9, flex: 'none', background: on ? 'var(--state-success)' : 'var(--border-strong)', display: 'flex', alignItems: 'center', padding: 2, justifyContent: on ? 'flex-end' : 'flex-start' }}
    >
      <span style={{ width: 14, height: 14, borderRadius: 7, background: 'var(--bg-raised)', display: 'block' }} />
    </button>
  );
}

/** Row with label + hint on the left and a control on the right (settings rows). */
export function SettingRow({ label, hint, children, mono }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: mono ? 12 : 13, lineHeight: '18px', fontFamily: mono ? MONO : undefined }}>{label}</span>
        {hint ? <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--text-muted)' }}>{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function Chip({ children, color, solid, style }: { children: React.ReactNode; color?: string; solid?: boolean; style?: React.CSSProperties }) {
  return (
    <span
      style={{
        fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 5px',
        whiteSpace: 'nowrap', flex: 'none', lineHeight: '16px', display: 'inline-block',
        ...(solid ? { background: color ?? 'var(--text-primary)', color: 'var(--text-inverse)' } : { color: color ?? 'var(--text-secondary)', border: '1px solid ' + (color ? `color-mix(in oklab, ${color} 55%, transparent)` : 'var(--border-strong)') }),
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function EnvBadge({ env }: { env: Environment | string }) {
  const prod = env === 'prod';
  return (
    <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '1px 5px', whiteSpace: 'nowrap', flex: 'none',
      background: prod ? 'var(--danger)' : 'transparent', color: prod ? '#10151A' : 'var(--text-secondary)', border: prod ? 'none' : '1px solid var(--border-strong)' }}>
      {env}
    </span>
  );
}

export function ReadOnlyBadge() {
  return <Chip>READ-ONLY</Chip>;
}

export function Label({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="label" style={style}>{children}</div>;
}

export function TextInput({ style, mono, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return (
    <input
      style={{ height: 28, padding: '0 9px', border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', fontSize: 13, fontFamily: mono ? MONO : undefined, minWidth: 0, ...style }}
      {...rest}
    />
  );
}

export function SearchBox({ value, onChange, placeholder, width = 220, kbd }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number | string; kbd?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 26, padding: '0 8px', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 3, width, flex: 'none' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>⌕</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={{ flex: 1, fontSize: 12, minWidth: 0 }} />
      {kbd ? <Kbd>{kbd}</Kbd> : null}
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', borderRadius: 3, padding: '0 5px', whiteSpace: 'nowrap' }}>{children}</span>;
}

export function Dot({ color, size = 7, pulse }: { color: string; size?: number; pulse?: boolean }) {
  return <span style={{ width: size, height: size, borderRadius: '50%', background: color, flex: 'none', display: 'inline-block', animation: pulse ? 'combpulse 1.6s ease-in-out infinite' : undefined }} />;
}

/** Thin vertical bars (sparkline in KPI tiles / topology cards). Values in [0,1]. */
export function Bars({ values, color = 'var(--state-info)', height = 22, gap = 2 }: { values: number[]; color?: string; height?: number; gap?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap, height }}>
      {values.map((v, i) => (
        <span key={i} style={{ flex: 1, minWidth: 2, height: Math.max(2, Math.round(v * height)), background: color, opacity: 0.35 + 0.65 * (i / Math.max(1, values.length - 1)) }} />
      ))}
    </div>
  );
}

/** Horizontal fill bar (share, bloat, load). */
export function Meter({ value, color = 'var(--state-info)', width = 80 }: { value: number; color?: string; width?: number | string }) {
  return (
    <div style={{ width, height: 6, background: 'var(--bg-inset)', borderRadius: 3, overflow: 'hidden', flex: 'none' }}>
      <span style={{ display: 'block', height: '100%', width: Math.max(0, Math.min(100, value * 100)) + '%', background: color }} />
    </div>
  );
}

/** Simple grid table with sticky header (admin screens). */
export function Table<T>({ columns, rows, template, rowKey, render, onRowClick, selected, empty, rowHeight = 34, minWidth }: {
  columns: Array<{ label: React.ReactNode; align?: 'left' | 'right' }>;
  rows: T[];
  template: string;
  rowKey: (r: T) => string;
  render: (r: T) => React.ReactNode[];
  onRowClick?: (r: T) => void;
  selected?: string | null;
  empty?: React.ReactNode;
  rowHeight?: number;
  minWidth?: number;
}) {
  return (
    <div style={{ minWidth }}>
      <div style={{ display: 'grid', gridTemplateColumns: template, height: 28, alignItems: 'center', position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg-raised)', borderBottom: '1px solid var(--border-subtle)' }}>
        {columns.map((c, i) => (
          <div key={i} className="label" style={{ padding: '0 10px', textAlign: c.align ?? 'left' }}>{c.label}</div>
        ))}
      </div>
      {rows.map((r) => {
        const k = rowKey(r);
        return (
          <div
            key={k}
            className="row-hover"
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            style={{ display: 'grid', gridTemplateColumns: template, minHeight: rowHeight, alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', cursor: onRowClick ? 'pointer' : 'default',
              background: selected === k ? 'var(--bg-selected)' : undefined }}
          >
            {render(r).map((cell, i) => (
              <div key={i} style={{ padding: '0 10px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: columns[i]?.align ?? 'left', fontSize: 13 }}>{cell}</div>
            ))}
          </div>
        );
      })}
      {rows.length === 0 && empty ? <div style={{ padding: '40px 16px', textAlign: 'center' }}>{empty}</div> : null}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '40px 16px', textAlign: 'center' }}>
      <div style={{ fontSize: 18, lineHeight: '24px', fontWeight: 600 }}>{title}</div>
      {body ? <div style={{ fontSize: 13, lineHeight: '19px', color: 'var(--text-secondary)', maxWidth: 460 }}>{body}</div> : null}
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 12, animation: 'combpulse 1.6s ease-in-out infinite' }}>{label}</div>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div style={{ margin: 16, padding: '10px 12px', border: '1px solid var(--state-error)', borderLeft: '3px solid var(--state-error)', borderRadius: 3, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span style={{ color: 'var(--state-error)' }}>✕</span>
      <div style={{ flex: 1, fontSize: 13, lineHeight: '18px' }}>{msg}</div>
      {onRetry ? <Button size="sm" onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}

/** Callout used for warnings like the RLS banner and migration lock warnings. */
export function Callout({ kind = 'warn', title, children }: { kind?: 'warn' | 'info' | 'error'; title?: React.ReactNode; children?: React.ReactNode }) {
  const c = kind === 'error' ? 'var(--state-error)' : kind === 'info' ? 'var(--state-info)' : 'var(--state-running)';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 11px', border: `1px solid color-mix(in oklab, ${c} 45%, transparent)`, borderLeft: `3px solid ${c}`, borderRadius: 3, background: `color-mix(in oklab, ${c} 7%, transparent)` }}>
      <span style={{ color: c, fontSize: 13 }}>{kind === 'info' ? '◆' : kind === 'error' ? '✕' : '⚠'}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 13, lineHeight: '18px' }}>
        {title ? <span style={{ fontWeight: 500 }}>{title}</span> : null}
        {children ? <span style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: '17px' }}>{children}</span> : null}
      </div>
    </div>
  );
}

/** Numbered code listing (DDL, migration statements, library SQL). */
export function CodeLines({ text, startAt = 1 }: { text: string; startAt?: number }) {
  const lines = text.split('\n');
  return (
    <div style={{ fontFamily: MONO, fontSize: 12, lineHeight: '19px', padding: '8px 0' }}>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex' }}>
          <span style={{ width: 38, flex: 'none', textAlign: 'right', paddingRight: 12, color: 'var(--text-muted)', userSelect: 'none' }}>{i + startAt}</span>
          <span style={{ whiteSpace: 'pre', color: 'var(--text-primary)' }}>{l || ' '}</span>
        </div>
      ))}
    </div>
  );
}

/** Big number + label tiles (KPIs). */
export function Stat({ value, label, note, unit, tone }: { value: React.ReactNode; label: React.ReactNode; note?: React.ReactNode; unit?: string; tone?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '11px 12px', border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-raised)', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontFamily: MONO, fontSize: 20, lineHeight: '26px', fontWeight: 500, color: tone ?? 'var(--text-primary)' }}>{value}</span>
        {unit ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{unit}</span> : null}
      </div>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</span>
      {note ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{note}</span> : null}
    </div>
  );
}

export function Modal({ title, onClose, width = 560, children, footer }: { title: React.ReactNode; onClose: () => void; width?: number; children: React.ReactNode; footer?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    ref.current?.querySelector<HTMLElement>('input,textarea,button')?.focus();
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgb(0 0 0 / 0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '9vh' }}>
      <div ref={ref} role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}
        style={{ width, maxWidth: 'calc(100vw - 32px)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-overlay)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: 'var(--shadow)' }}>
        <div style={{ padding: '14px 16px 10px', fontSize: 15, fontWeight: 600 }}>{title}</div>
        <div style={{ padding: '0 16px 14px', overflow: 'auto', minHeight: 0 }}>{children}</div>
        {footer ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderTop: '1px solid var(--border-subtle)' }}>{footer}</div> : null}
      </div>
    </div>
  );
}

/** Two-column split: list on the left, detail on the right (approvals, migrations, library...). */
export function Split({ left, right, leftWidth = 320 }: { left: React.ReactNode; right: React.ReactNode; leftWidth?: number }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{ width: leftWidth, flex: 'none', borderRight: '1px solid var(--border-subtle)', overflow: 'auto', background: 'var(--bg-raised)' }}>{left}</div>
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>{right}</div>
    </div>
  );
}

/** Page wrapper for admin screens that read like documents (Security, Team, Deployment...). */
export function Page({ title, subtitle, actions, children, maxWidth = 1080 }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; maxWidth?: number }) {
  return (
    <div className="screen">
      <div style={{ maxWidth, margin: '0 auto', padding: '22px 24px 40px', display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 22, lineHeight: '28px', fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</div>
            {subtitle ? <div style={{ fontSize: 13, lineHeight: '19px', color: 'var(--text-secondary)', maxWidth: 640 }}>{subtitle}</div> : null}
          </div>
          {actions}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Section({ label, right, children }: { label: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Label>{label}</Label>
        <span className="spacer" />
        {right}
      </div>
      {children}
    </div>
  );
}

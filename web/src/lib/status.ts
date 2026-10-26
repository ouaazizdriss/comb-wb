import { create } from 'zustand';

/** Status bar state. The query and table screens report into it. */
export const useStatus = create<{
  state: 'idle' | 'running' | 'error';
  lastQuery: string;
  rows: string;
  latency: string;
  schema: string;
  report: (p: Partial<{ state: 'idle' | 'running' | 'error'; lastQuery: string; rows: string; latency: string; schema: string }>) => void;
}>((set) => ({
  state: 'idle',
  lastQuery: 'no query yet',
  rows: '—',
  latency: '—',
  schema: 'public',
  report: (p) => set(p),
}));

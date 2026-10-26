import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import { useApp } from './store.ts';

export interface TreeSchema {
  name: string;
  tables: Array<{ name: string; est: number; kind: string }>;
  views: Array<{ name: string; kind: string }>;
  functions: string[];
  enums: string[];
}

/** Catalog tree of the open connection (sidebar, palette, AI context, ERD schema picker). */
export function useTree() {
  const conn = useApp((s) => s.conn);
  return useQuery({
    queryKey: ['tree', conn?.id],
    queryFn: () => api.get<{ version: string; schemas: TreeSchema[] }>(`/connections/${conn!.id}/tree`),
    enabled: !!conn,
    staleTime: 60_000,
  });
}

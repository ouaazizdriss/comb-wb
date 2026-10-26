/*
 * AI panel contract shared by server and web: context modes, feature ids, the pinned
 * output contract and the parser that splits a model answer into { sql, prose }.
 */

export const AI_MODES = ['schema', 'samples', 'none'] as const;
export type AiMode = (typeof AI_MODES)[number];

export const AI_INTENTS = ['sql', 'explain', 'fix', 'optimise', 'result'] as const;
export type AiIntent = (typeof AI_INTENTS)[number];

/** Feature toggles (ids from the mockup) and the intent each one gates. */
export const AI_FEATURES = [
  { id: 'F-50', label: 'Natural language → SQL draft', intent: 'sql' },
  { id: 'F-51', label: 'Explain this query', intent: 'explain' },
  { id: 'F-52', label: 'Fix this error, offered inline on failure', intent: 'fix' },
  { id: 'F-53', label: 'Optimise / suggest indexes from EXPLAIN', intent: 'optimise' },
  { id: 'F-54', label: 'Explain this result set', intent: 'result' },
  { id: 'F-57', label: 'Follow-up conversation with query context', intent: null },
] as const;
export type AiFeatureId = (typeof AI_FEATURES)[number]['id'];

export const AI_MODEL_PRESETS = [
  { id: 'claude-sonnet-5-5', note: 'Balanced. The default for schema-aware SQL drafting.' },
  { id: 'claude-opus-5-5', note: 'Slower, better on 200-table schemas and gnarly window functions.' },
  { id: 'claude-haiku-5-5', note: 'Fast and cheap. Good for explain-this and error fixes.' },
] as const;
export const AI_MODEL_RE = /^[a-z0-9.-]{3,64}$/;

/** The pinned output contract, verbatim from the mockup. */
export const AI_CONTRACT_RULES = [
  'One fenced sql block, then assumptions as prose — never the other way round.',
  'Explicit JOIN syntax; qualify columns when more than one table is involved.',
  'Never invent a column — say what is missing and ask.',
  'LIMIT on exploratory selects.',
  'Identifier casing taken from the catalog, quoted when required.',
] as const;

export interface AiConfig {
  model: string;
  defaultMode: AiMode;
  samples: number;
  budgetK: number;
  hardOff: boolean;
  redact: string[];
  features: Record<AiFeatureId, boolean>;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  model: 'claude-sonnet-5-5',
  defaultMode: 'schema',
  samples: 5,
  budgetK: 40,
  hardOff: false,
  redact: ['password', 'token', 'secret', 'ssn', 'card', 'api_key'],
  features: { 'F-50': true, 'F-51': true, 'F-52': true, 'F-53': true, 'F-54': false, 'F-57': true },
};

/** Guesses the intent of a free-text prompt (chips and "Fix with AI" set it explicitly). */
export function guessIntent(text: string): AiIntent {
  if (/^fix\b|fix this|error|does not exist/i.test(text)) return 'fix';
  if (/^optimi[sz]e|index(es)? for|suggest index/i.test(text)) return 'optimise';
  if (/^explain\b|^describe\b/i.test(text)) return 'explain';
  return 'sql';
}

/**
 * Splits an answer into the first fenced SQL block and the prose around it.
 * Works on partial (streaming) text: an unclosed fence yields the SQL so far.
 */
export function parseAnswer(text: string): { sql: string; prose: string } {
  const open = /```[ \t]*(sql|postgres(?:ql)?|pgsql|plpgsql)?[ \t]*\r?\n/i.exec(text);
  if (!open) return { sql: '', prose: text.trim() };
  const start = open.index + open[0].length;
  const close = text.indexOf('```', start);
  const sql = (close === -1 ? text.slice(start) : text.slice(start, close)).replace(/\s+$/, '');
  const before = text.slice(0, open.index).trim();
  const after = close === -1 ? '' : text.slice(close + 3).trim();
  return { sql, prose: [before, after].filter(Boolean).join('\n\n') };
}

/** Rough token estimate used for budgets and the preview (≈ 4 characters per token). */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

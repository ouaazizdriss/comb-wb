/*
 * Query-tab helpers shared by the web client (and testable on the server):
 * a small SQL tokenizer, statement splitting for "run the statement under the cursor",
 * and a deterministic formatter. The server re-splits and classifies with the real
 * Postgres parser; this is only for editor ergonomics.
 */

export type TokKind = 'ws' | 'line-comment' | 'block-comment' | 'string' | 'dollar' | 'qident' | 'number' | 'word' | 'param' | 'op' | 'punct';
export interface Tok { kind: TokKind; text: string; start: number; end: number }

const OPS = ['->>', '#>>', '::', '<=', '>=', '<>', '!=', '||', '->', '#>', '@>', '<@', '&&', '!!', '~*', '!~', '**'];

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  const push = (kind: TokKind, end: number) => {
    out.push({ kind, text: src.slice(i, end), start: i, end });
    i = end;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j++;
      push('ws', j);
    } else if (c === '-' && d === '-') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      push('line-comment', j);
    } else if (c === '/' && d === '*') {
      // Postgres block comments nest.
      let depth = 0;
      let j = i;
      while (j < n) {
        if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; continue; }
        if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; if (depth === 0) break; continue; }
        j++;
      }
      push('block-comment', Math.min(j, n));
    } else if (c === "'" || ((c === 'E' || c === 'e') && d === "'")) {
      const esc = c !== "'";
      let j = i + (esc ? 2 : 1);
      while (j < n) {
        if (esc && src[j] === '\\') { j += 2; continue; }
        if (src[j] === "'") {
          if (src[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      push('string', Math.min(j, n));
    } else if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      push('qident', Math.min(j, n));
    } else if (c === '$' && /[A-Za-z_$]/.test(d ?? '')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      if (m) {
        const close = src.indexOf(m[0], i + m[0].length);
        push('dollar', close < 0 ? n : close + m[0].length);
      } else push('op', i + 1);
    } else if (c === '$' && /[0-9]/.test(d ?? '')) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(src[j])) j++;
      push('param', j);
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d ?? ''))) {
      const m = /^(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
      push('number', i + (m ? m[0].length : 1));
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(src[j])) j++;
      push('word', j);
    } else if ('(),;[].'.includes(c)) {
      push('punct', i + 1);
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (op) push('op', i + op.length);
      else {
        let j = i + 1;
        while (j < n && '+-*/<>=~!@#%^&|`?'.includes(src[j]) && !(src[j] === '-' && src[j + 1] === '-') && !(src[j] === '/' && src[j + 1] === '*')) j++;
        push('op', j);
      }
    }
  }
  return out;
}

export interface Stmt {
  /** Offset of the first significant character. */
  from: number;
  /** Offset just after the last significant character (before the ';'). */
  to: number;
  /** Offset just after the terminating ';' (or `to` when there is none). */
  end: number;
  text: string;
}

const isTrivia = (t: Tok) => t.kind === 'ws' || t.kind === 'line-comment' || t.kind === 'block-comment';

/** Splits on top-level semicolons, ignoring quotes, comments and dollar-quoted bodies. */
export function splitStatements(src: string): Stmt[] {
  const toks = tokenize(src);
  const out: Stmt[] = [];
  let cur: Tok[] = [];
  let depth = 0;
  const flush = (end: number) => {
    const sig = cur.filter((t) => !isTrivia(t));
    if (sig.length) {
      // Keep leading comments with the statement (they document it); trim whitespace only.
      const firstNonWs = cur.find((t) => t.kind !== 'ws')!;
      const from = firstNonWs.start;
      const to = sig[sig.length - 1].end;
      out.push({ from, to, end: Math.max(end, to), text: src.slice(from, to) });
    }
    cur = [];
  };
  for (const t of toks) {
    if (t.kind === 'punct' && (t.text === '(' || t.text === '[')) depth++;
    if (t.kind === 'punct' && (t.text === ')' || t.text === ']')) depth = Math.max(0, depth - 1);
    if (t.kind === 'punct' && t.text === ';' && depth === 0) {
      flush(t.end);
      continue;
    }
    cur.push(t);
  }
  flush(src.length);
  return out;
}

/** The statement the cursor is in; between statements, the one just before the cursor. */
export function statementAt(src: string, pos: number): Stmt | null {
  const all = splitStatements(src);
  if (!all.length) return null;
  for (const s of all) if (pos >= s.from && pos <= s.end) return s;
  let best: Stmt | null = null;
  for (const s of all) if (s.end <= pos) best = s;
  return best ?? all[0];
}

// ── Formatter ─────────────────────────────────────────────────────

const KEYWORDS = new Set((
  'all and any array as asc between by case cast check collate column constraint create cross current_date current_time current_timestamp ' +
  'current_user default delete desc distinct do drop else end except exists false fetch filter first following for foreign from full grant ' +
  'group having ilike in inner insert intersect interval into is join key last lateral left like limit natural not null nulls offset on ' +
  'only or order outer over partition preceding primary range recursive references returning right row rows select set similar some ' +
  'table then to true unbounded union unique update using values view when where window with within without conflict nothing ' +
  'alter add index if replace begin commit rollback explain analyze verbose format json show reset vacuum truncate cascade restrict ' +
  'materialized temporary temp unlogged sequence trigger function procedure returns language immutable stable volatile security definer ' +
  'boolean bool int int2 int4 int8 integer bigint smallint numeric decimal real double precision text varchar char character varying ' +
  'timestamp timestamptz date time timetz uuid jsonb bytea serial bigserial zone at escape ordinality tablesample current_schema ' +
  'search_path session local extract epoch coalesce nullif greatest least count sum avg min max now'
).split(' '));

const SPACE_BEFORE_PAREN = new Set(['in', 'as', 'values', 'exists', 'and', 'or', 'not', 'on', 'using', 'from', 'join', 'where', 'select', 'when',
  'then', 'else', 'over', 'filter', 'within', 'into', 'returning', 'by', 'with', 'lateral', 'any', 'all', 'some', 'table', 'union', 'is', 'do',
  'conflict', 'set', 'distinct', 'group', 'partition', 'check', 'unique', 'key', 'references', 'like', 'ilike', 'between', 'case', 'array']);

/** Formats SQL: lowercase keywords, single spaces, a new line before each major clause. Deterministic. */
export function formatSql(src: string): string {
  const toks = tokenize(src).filter((t) => t.kind !== 'ws');
  const lower = (t: Tok) => (t.kind === 'word' ? t.text.toLowerCase() : t.text);
  const words = toks.map(lower);
  let out = '';
  let indent = 0;
  let line = '';
  const stack: Array<{ sub: boolean; indent: number }> = [];
  let clause = '';
  let betweenPending = false;
  const newline = (extra = 0) => {
    if (line.trim()) out += line.replace(/\s+$/, '') + '\n';
    line = ' '.repeat(indent + extra);
  };
  const emit = (text: string, space: boolean) => {
    if (space && line.length && !/\s$/.test(line)) line += ' ';
    line += text;
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const w = words[i];
    const prev = i > 0 ? toks[i - 1] : null;
    const pw = i > 0 ? words[i - 1] : '';
    const nw = words[i + 1] ?? '';
    const isKw = t.kind === 'word' && KEYWORDS.has(w);
    let text = isKw ? w : t.text;
    if (t.kind === 'line-comment') {
      emit(t.text, true);
      newline();
      continue;
    }
    if (t.kind === 'block-comment') {
      emit(t.text, true);
      continue;
    }

    // Major clauses start on a new line at the current indent.
    if (t.kind === 'word') {
      let breakHere = false;
      const atLineStart = !line.trim();
      if (['select', 'from', 'where', 'having', 'limit', 'offset', 'returning', 'window', 'values', 'union', 'intersect', 'except'].includes(w)) breakHere = true;
      if ((w === 'group' || w === 'order') && nw === 'by') breakHere = true;
      if (w === 'join' && !['left', 'right', 'full', 'inner', 'cross', 'outer', 'natural', 'lateral'].includes(pw)) breakHere = true;
      if (['left', 'right', 'full', 'inner', 'cross', 'natural'].includes(w) && (nw === 'join' || nw === 'outer' || words[i + 2] === 'join')) breakHere = true;
      if (w === 'set' && clause === 'update') breakHere = true;
      if (w === 'on' && nw === 'conflict') breakHere = true;
      if (w === 'values' && pw === 'default') breakHere = false;
      if (w === 'union' || w === 'intersect' || w === 'except') breakHere = true;
      if (w === 'select' && (pw === 'all' || pw === 'distinct')) breakHere = false;
      if (w === 'select' && (pw === 'union' || pw === 'intersect' || pw === 'except')) breakHere = true;
      // Inside a non-subquery paren (function args, column lists) never break.
      if (stack.length && !stack[stack.length - 1].sub) breakHere = false;
      if (breakHere && !atLineStart) newline();
      if (['select', 'from', 'where', 'having', 'update', 'insert', 'delete', 'set', 'on', 'values', 'join'].includes(w) && (breakHere || atLineStart || w === 'on')) {
        if (w !== 'on' || nw === 'conflict') clause = w;
        if (w === 'on' && nw !== 'conflict') clause = 'on';
      }
      if ((w === 'and' || w === 'or') && (clause === 'where' || clause === 'having') && !betweenPending && !(stack.length && !stack[stack.length - 1].sub)) {
        newline(2);
      }
      if (w === 'between') betweenPending = true;
      else if (w === 'and' && betweenPending) betweenPending = false;
    }

    if (t.kind === 'punct') {
      if (t.text === ';') {
        line = line.replace(/\s+$/, '') + ';';
        newline();
        out += '\n';
        indent = 0;
        stack.length = 0;
        clause = '';
        continue;
      }
      if (t.text === '(') {
        const sub = nw === 'select' || nw === 'with' || nw === 'values';
        const space = prev ? (prev.kind === 'word' ? SPACE_BEFORE_PAREN.has(pw) || words[i - 2] === 'into' || (prev.kind === 'word' && pw === 'as') : prev.kind === 'op' || (prev.kind === 'punct' && prev.text === ',')) : false;
        emit('(', space);
        stack.push({ sub, indent });
        if (sub) {
          indent += 2;
          newline();
        }
        continue;
      }
      if (t.text === ')') {
        const top = stack.pop();
        if (top?.sub) {
          indent = top.indent;
          newline();
          line = line.replace(/\s+$/, '');
          if (!line.trim()) line = ' '.repeat(indent);
          line += ')';
        } else line = line.replace(/\s+$/, '') + ')';
        continue;
      }
      if (t.text === ',') { line = line.replace(/\s+$/, '') + ','; continue; }
      if (t.text === '.') { line = line.replace(/\s+$/, '') + '.'; continue; }
      if (t.text === '[') { line = line.replace(/\s+$/, '') + '['; continue; }
      if (t.text === ']') { line = line.replace(/\s+$/, '') + ']'; continue; }
    }
    if (t.kind === 'op' && t.text === '::') { line = line.replace(/\s+$/, '') + '::'; continue; }

    const glued = prev && ((prev.kind === 'punct' && (prev.text === '(' || prev.text === '.' || prev.text === '[')) || (prev.kind === 'op' && prev.text === '::'));
    if (prev && prev.kind === 'op' && (prev.text === '-' || prev.text === '+') && (i < 2 || toks[i - 2].kind === 'op' || (toks[i - 2].kind === 'punct' && toks[i - 2].text !== ')') || (toks[i - 2].kind === 'word' && KEYWORDS.has(words[i - 2])))) {
      line += text;
      continue;
    }
    if (t.kind === 'word' && !isKw) text = t.text;
    emit(text, !glued);
  }
  newline();
  return out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

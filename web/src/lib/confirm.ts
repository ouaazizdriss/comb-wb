import { ApiError } from './api.ts';
import { useApp } from './store.ts';

/**
 * Runs an API call; if the server answers 409 COMB_CONFIRM (destructive statement),
 * shows the typed-confirmation dialog and retries with the typed word.
 * The server is the one enforcing it — this only collects the word.
 */
export async function withConfirm<T>(call: (confirm?: string) => Promise<T>, opts: { title?: string; body?: string } = {}): Promise<T | undefined> {
  try {
    return await call();
  } catch (e) {
    if (!(e instanceof ApiError) || !e.confirm) throw e;
    const c = e.confirm;
    return new Promise<T | undefined>((resolve, reject) => {
      useApp.getState().set({
        confirm: {
          title: opts.title ?? `${c.kind} ${c.target}`,
          body: opts.body ?? defaultBody(c.kind),
          sql: c.sql,
          word: c.word,
          action: c.kind,
          onCancel: () => resolve(undefined),
          onConfirm: async (typed) => {
            try {
              resolve(await call(typed));
            } catch (err) {
              reject(err);
            }
          },
        },
      });
    });
  }
}

function defaultBody(kind: string): string {
  switch (kind) {
    case 'DROP': return 'This removes the object and everything stored in it. There is no undo from Comb.';
    case 'TRUNCATE': return 'Every row in the table is removed immediately. There is no undo from Comb.';
    case 'DELETE': return 'This DELETE has no WHERE clause, so it removes every row.';
    case 'UPDATE': return 'This UPDATE has no WHERE clause, so it changes every row.';
    default: return 'This change cannot be undone from Comb.';
  }
}

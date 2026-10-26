import { describe, it, expect, beforeAll } from 'vitest';
import { classify, initClassifier, redactLiterals, SqlSyntaxError } from '../src/targets/classify.ts';

beforeAll(() => initClassifier());
const one = (sql: string) => classify(sql)[0];

describe('classifier', () => {
  it('reads', () => {
    expect(one('select * from public.users').kind).toBe('read');
    expect(one('select * from public.users').targets).toEqual(['public.users']);
    expect(one('explain select 1').kind).toBe('read');
    expect(one('show search_path').kind).toBe('read');
  });
  it('writes hidden in reads are writes', () => {
    expect(one('with d as (delete from users returning *) select * from d').kind).toBe('write');
    expect(one('select * from users for update').kind).toBe('write');
    expect(one('explain analyze delete from users where id = 1').kind).toBe('write');
    expect(one('explain (analyze false) delete from users').kind).toBe('read');
    expect(one('select * into x from users').kind).toBe('ddl');
  });
  it('destructive statements', () => {
    expect(one('delete from users').destructive).toEqual({ kind: 'DELETE', target: 'users' });
    expect(one('delete from users where id = 1').destructive).toBeNull();
    expect(one('update users set plan = 1').destructive?.kind).toBe('UPDATE');
    expect(one('truncate public.orders').destructive).toEqual({ kind: 'TRUNCATE', target: 'public.orders' });
    expect(one('drop table public.users').destructive).toEqual({ kind: 'DROP', target: 'public.users' });
    expect(one('drop role app').kind).toBe('privilege');
  });
  it('blocks session escapes', () => {
    expect(one('begin').blocked).toBeTruthy();
    expect(one('commit').blocked).toBeTruthy();
    expect(one('set default_transaction_read_only = off').blocked).toBeTruthy();
    expect(one('set role postgres').blocked).toBeTruthy();
    expect(one('set session authorization postgres').blocked).toBeTruthy();
    expect(one('reset all').blocked).toBeTruthy();
    expect(one('set search_path = public').blocked).toBeNull();
    expect(one("copy users to '/tmp/x'").blocked).toBeTruthy();
    expect(one("copy users from program 'id'").blocked).toBeTruthy();
    expect(one('prepare p as delete from users').blocked).toBeTruthy();
    expect(one("load 'x'").blocked).toBeTruthy();
  });
  it('blocks session escapes through functions', () => {
    expect(one("select set_config('role', 'postgres', false)").blocked).toBeTruthy();
    expect(one("select pg_catalog.set_config('statement_timeout', '0', true)").blocked).toBeTruthy();
    expect(one("select set_config(current_setting('x'), 'y', false)").blocked).toBeTruthy();
    expect(one("select set_config('search_path', 'public', true)").blocked).toBeNull();
    expect(one("select pg_read_file('/etc/passwd')").blocked).toBeTruthy();
    expect(one("select * from dblink('host=x', 'delete from t') as t(a int)").blocked).toBeTruthy();
    expect(one("select lo_import('/etc/passwd')").blocked).toBeTruthy();
    expect(one("with x as (select set_config('role','postgres',false)) select * from x").blocked).toBeTruthy();
    expect(one("select query_to_xml('set role postgres', true, true, '')").blocked).toBeTruthy();
    expect(one("select * from ts_stat('select 1')").blocked).toBeTruthy();
    expect(one("select pg_ls_logicalmapdir()").blocked).toBeTruthy();
  });
  it('privileges and ddl', () => {
    expect(one('grant select on users to analyst').kind).toBe('privilege');
    expect(one('alter role app superuser').kind).toBe('privilege');
    expect(one('create table t (id int)').kind).toBe('ddl');
    expect(one('create index concurrently i on t(id)').noTxn).toBe(true);
    expect(one('vacuum users').noTxn).toBe(true);
    expect(one('do $$ begin perform 1; end $$').kind).toBe('write');
  });
  it('splits statements with offsets', () => {
    const src = 'select 1;\n  update users set plan = 2 where id = 3;';
    const r = classify(src);
    expect(r.map((x) => x.command)).toEqual(['SELECT', 'UPDATE']);
    expect(src.slice(r[1].start, r[1].start + 6)).toBe('update');
  });
  it('reports syntax errors with position', () => {
    try { classify('select from where'); expect.fail(); } catch (e) {
      expect(e).toBeInstanceOf(SqlSyntaxError);
      expect((e as SqlSyntaxError).position).toBeGreaterThan(0);
    }
  });
  it('redacts literals, and never echoes them from unparseable text', () => {
    expect(redactLiterals("alter role bob password 'hunter2'")).not.toContain('hunter2');
    expect(redactLiterals("select * from users where email = 'alice@example.com'")).toBe('select * from users where email = $1');
    // An unterminated string makes normalizeSync return its error message, which quotes the literal.
    expect(redactLiterals("select * from users where email = 'alic")).not.toContain('alic');
    expect(redactLiterals("selec 'pw123'")).not.toContain('pw123');
  });
});

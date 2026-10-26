-- Development only: passwords here are throwaway values for the local container.
-- Comb's metadata database. Migrations run as comb_owner; the server runs as comb_app,
-- which never owns tables, so it cannot disable the audit trigger or rewrite history.
create role comb_owner login password 'comb-owner-dev-only';
create role comb_app login password 'comb-app-dev-only';
create database comb_meta owner comb_owner;
revoke all on database comb_meta from public;
grant connect on database comb_meta to comb_app;

-- Demo target database ("shop") used by "Load the demo database" and by tests.
create database shop;
create role app login password 'app-dev-only';
create role analyst login password 'analyst-dev-only';
create role readonly nologin;
create role reporting login password 'reporting-dev-only' connection limit 5;
grant readonly to reporting;

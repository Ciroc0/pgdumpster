-- Dedicated disposable-project fixture for the hosted pgDumpster E2E procedure.
-- Do not run this against a project containing non-test data.

drop schema if exists pgdumpster_e2e cascade;
create schema pgdumpster_e2e;

create type pgdumpster_e2e.job_state as enum ('queued', 'running', 'complete');

create table pgdumpster_e2e.accounts (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table pgdumpster_e2e.jobs (
  id bigint generated always as identity primary key,
  account_id uuid not null references pgdumpster_e2e.accounts(id) on delete cascade,
  state pgdumpster_e2e.job_state not null default 'queued',
  payload jsonb not null,
  checksum text not null,
  created_at timestamptz not null default now(),
  check (length(checksum) = 64)
);

create function pgdumpster_e2e.set_job_checksum()
returns trigger
language plpgsql
as $$
begin
  new.checksum := encode(digest(new.payload::text, 'sha256'), 'hex');
  return new;
end;
$$;

create trigger jobs_checksum
before insert or update of payload on pgdumpster_e2e.jobs
for each row execute procedure pgdumpster_e2e.set_job_checksum();

create view pgdumpster_e2e.job_summary with (security_invoker = true) as
select account_id, state, count(*) as job_count
from pgdumpster_e2e.jobs
group by account_id, state;

alter table pgdumpster_e2e.accounts enable row level security;
alter table pgdumpster_e2e.jobs enable row level security;
create policy e2e_account_owner on pgdumpster_e2e.accounts
  for select to authenticated using (id = auth.uid());
create policy e2e_job_owner on pgdumpster_e2e.jobs
  for select to authenticated
  using (account_id = auth.uid());

insert into pgdumpster_e2e.accounts (id, handle, display_name) values
  ('00000000-0000-4000-8000-000000000001', 'fixture-alpha', 'Fixture Alpha'),
  ('00000000-0000-4000-8000-000000000002', 'fixture-unicode', 'Æble Ønske');

insert into pgdumpster_e2e.jobs (account_id, state, payload, checksum) values
  ('00000000-0000-4000-8000-000000000001', 'queued', '{"kind":"baseline","ordinal":1}', repeat('0', 64)),
  ('00000000-0000-4000-8000-000000000002', 'complete', '{"canary":"CANARY_PGDUMPSTER_MARKER_9b92_E2E","unicode":"på vej"}', repeat('0', 64));

alter table pgdumpster_e2e.jobs replica identity full;
alter publication supabase_realtime add table pgdumpster_e2e.jobs;

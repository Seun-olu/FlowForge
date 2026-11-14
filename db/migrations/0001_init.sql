-- FlowForge schema. Supabase-compatible: relies only on auth.users, auth.uid()
-- and the anon/authenticated roles (stubbed by db/supabase-stub.sql locally).
--
-- Authorisation model:
--   * Reads go through RLS as `authenticated` (members see their org's rows).
--   * Workflow drafts, publishing, orgs and memberships are written through RLS.
--   * Execution state (executions, steps, approvals, logs, audit) is written only
--     by the server-side engine as the table owner, after it has checked the
--     caller's permission with private.can_run / private.can_approve inside the
--     same transaction. `authenticated` has no write privileges on those tables.

create schema if not exists private;

create type public.org_role as enum ('owner', 'admin', 'editor', 'approver', 'viewer');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  display_name text not null check (char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_role not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index on public.org_members (user_id);

create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  draft_graph jsonb not null default '{"nodes":[],"edges":[]}',
  published_version_id uuid,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.workflows (org_id);

-- Published versions are immutable snapshots of a validated graph.
create table public.workflow_versions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  version int not null default 0,
  graph jsonb not null,
  published_by uuid not null references auth.users (id),
  published_at timestamptz not null default now(),
  unique (workflow_id, version)
);
alter table public.workflows
  add constraint workflows_published_version_fk foreign key (published_version_id)
  references public.workflow_versions (id) on delete set null;

create table public.executions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  version_id uuid not null references public.workflow_versions (id),
  status text not null check (status in ('running', 'waiting_approval', 'succeeded', 'failed', 'rejected', 'cancelled')),
  input jsonb not null default '{}',
  vars jsonb not null default '{}',
  error text,
  idempotency_key text,
  next_run_at timestamptz,
  started_by uuid not null references auth.users (id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workflow_id, idempotency_key)
);
create index on public.executions (org_id, started_at desc);
create index executions_due_idx on public.executions (next_run_at) where status = 'running' and next_run_at is not null;

create table public.execution_steps (
  id uuid primary key,
  execution_id uuid not null references public.executions (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  node_id text not null,
  node_type text not null check (node_type in ('start', 'approval', 'condition', 'action', 'end')),
  seq int not null,
  status text not null check (status in ('pending', 'running', 'waiting_approval', 'succeeded', 'failed', 'skipped')),
  attempt int not null default 0,
  max_attempts int not null default 1 check (max_attempts between 1 and 5),
  idempotency_key text not null unique,
  output jsonb,
  error text,
  run_after timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  unique (execution_id, seq)
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  execution_id uuid not null references public.executions (id) on delete cascade,
  step_id uuid not null unique references public.execution_steps (id) on delete cascade,
  node_id text not null,
  title text not null,
  instructions text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  comment text check (char_length(comment) <= 500),
  created_at timestamptz not null default now()
);
create index on public.approvals (org_id, status);

create table public.execution_logs (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  execution_id uuid not null references public.executions (id) on delete cascade,
  step_id uuid references public.execution_steps (id) on delete cascade,
  level text not null check (level in ('info', 'warn', 'error')),
  message text not null,
  data jsonb,
  created_at timestamptz not null default now()
);
create index on public.execution_logs (execution_id, id);

create table public.audit_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  actor_id uuid references auth.users (id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on public.audit_events (org_id, id desc);

-- Local-mode password store (unused when running on Supabase Auth).
create table private.local_credentials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  password_hash text not null
);

---------------------------------------------------------------------------
-- Role helpers (private schema: not exposed through PostgREST)
---------------------------------------------------------------------------
create function private.org_role(p_org uuid) returns public.org_role
language sql stable security definer set search_path = '' as $$
  select role from public.org_members where org_id = p_org and user_id = auth.uid()
$$;

create function private.has_role(p_org uuid, p_roles public.org_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.org_role(p_org) = any (p_roles), false)
$$;

create function private.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.org_role(p_org) is not null
$$;

create function private.can_edit(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(p_org, array['owner', 'admin', 'editor']::public.org_role[])
$$;
create function private.can_run(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(p_org, array['owner', 'admin', 'editor']::public.org_role[])
$$;
create function private.can_approve(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(p_org, array['owner', 'admin', 'approver']::public.org_role[])
$$;
create function private.can_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(p_org, array['owner', 'admin']::public.org_role[])
$$;

grant usage on schema private to authenticated;
revoke all on all functions in schema private from public;
grant execute on function private.org_role, private.has_role, private.is_member, private.can_edit,
  private.can_run, private.can_approve, private.can_admin to authenticated;

---------------------------------------------------------------------------
-- Triggers
---------------------------------------------------------------------------
create function private.audit(p_org uuid, p_action text, p_type text, p_id text, p_data jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_events (org_id, actor_id, action, entity_type, entity_id, data)
  values (p_org, auth.uid(), p_action, p_type, p_id, coalesce(p_data, '{}'))
$$;

-- The creator of an organization becomes its owner.
create function private.on_org_created() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.org_members (org_id, user_id, role) values (new.id, new.created_by, 'owner');
  perform private.audit(new.id, 'org.created', 'organization', new.id::text, jsonb_build_object('name', new.name));
  return new;
end $$;
create trigger org_created after insert on public.organizations
  for each row execute function private.on_org_created();

create function private.on_member_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := coalesce(new.org_id, old.org_id);
  v_org_exists boolean := exists (select 1 from public.organizations where id = v_org);
begin
  -- Cascading delete of the whole organization: nothing to protect or audit.
  if not v_org_exists then
    return coalesce(new, old);
  end if;
  -- Keep at least one owner.
  if tg_op <> 'INSERT' and old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') and not exists (
    select 1 from public.org_members where org_id = v_org and role = 'owner' and user_id <> old.user_id
  ) then
    raise exception 'An organization must keep at least one owner' using errcode = 'check_violation';
  end if;
  if tg_op <> 'INSERT' or new.user_id <> (select created_by from public.organizations where id = v_org) then
    perform private.audit(v_org, 'member.' || lower(tg_op), 'member', coalesce(new.user_id, old.user_id)::text,
      jsonb_build_object('role', coalesce(new.role, old.role)));
  end if;
  return coalesce(new, old);
end $$;
create trigger member_changed after insert or update or delete on public.org_members
  for each row execute function private.on_member_changed();

create function private.on_workflow_written() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.audit(new.org_id, 'workflow.created', 'workflow', new.id::text, jsonb_build_object('name', new.name));
  end if;
  return new;
end $$;
create trigger workflow_written after insert on public.workflows
  for each row execute function private.on_workflow_written();

create function private.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger workflows_touch before update on public.workflows
  for each row execute function private.touch_updated_at();

-- Number new versions, pin org_id to the workflow's org, and point the workflow at it.
create function private.on_version_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.workflows where id = new.workflow_id for update;
  new.org_id := v_org;
  select coalesce(max(version), 0) + 1 into new.version from public.workflow_versions where workflow_id = new.workflow_id;
  return new;
end $$;
create trigger version_insert before insert on public.workflow_versions
  for each row execute function private.on_version_insert();

create function private.on_version_published() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.workflows set published_version_id = new.id where id = new.workflow_id;
  perform private.audit(new.org_id, 'workflow.published', 'workflow', new.workflow_id::text,
    jsonb_build_object('version', new.version, 'version_id', new.id));
  return new;
end $$;
create trigger version_published after insert on public.workflow_versions
  for each row execute function private.on_version_published();

create function private.reject_change() returns trigger language plpgsql as $$
begin
  raise exception '% rows are immutable', tg_table_name using errcode = 'insufficient_privilege';
end $$;
create trigger versions_immutable before update on public.workflow_versions
  for each row execute function private.reject_change();
-- Audit rows can't be edited or deleted, except when their organization is deleted.
create function private.audit_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.org_id) then
    return old;
  end if;
  raise exception 'audit_events rows are immutable' using errcode = 'insufficient_privilege';
end $$;
create trigger audit_append_only before update or delete on public.audit_events
  for each row execute function private.audit_guard();

---------------------------------------------------------------------------
-- Row-level security
---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.workflows enable row level security;
alter table public.workflow_versions enable row level security;
alter table public.executions enable row level security;
alter table public.execution_steps enable row level security;
alter table public.approvals enable row level security;
alter table public.execution_logs enable row level security;
alter table public.audit_events enable row level security;
alter table private.local_credentials enable row level security;

create policy "see self and co-members" on public.profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from public.org_members m where m.user_id = profiles.id and private.is_member(m.org_id)
  )
);
create policy "update own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "members read" on public.organizations for select to authenticated
  using (private.is_member(id) or created_by = auth.uid());
create policy "anyone signed in creates" on public.organizations for insert to authenticated
  with check (created_by = auth.uid());
create policy "admins rename" on public.organizations for update to authenticated
  using (private.can_admin(id)) with check (private.can_admin(id));
create policy "owners delete" on public.organizations for delete to authenticated
  using (private.has_role(id, array['owner']::public.org_role[]));

create policy "members read" on public.org_members for select to authenticated using (private.is_member(org_id));
-- Admins manage members; only owners may grant, change or remove the owner role.
create policy "admins add" on public.org_members for insert to authenticated with check (
  private.can_admin(org_id) and (role <> 'owner' or private.has_role(org_id, array['owner']::public.org_role[]))
);
create policy "admins change" on public.org_members for update to authenticated
  using (private.can_admin(org_id) and (role <> 'owner' or private.has_role(org_id, array['owner']::public.org_role[])))
  with check (private.can_admin(org_id) and (role <> 'owner' or private.has_role(org_id, array['owner']::public.org_role[])));
create policy "admins remove" on public.org_members for delete to authenticated
  using (private.can_admin(org_id) and (role <> 'owner' or private.has_role(org_id, array['owner']::public.org_role[])));

create policy "members read" on public.workflows for select to authenticated using (private.is_member(org_id));
create policy "editors create" on public.workflows for insert to authenticated
  with check (private.can_edit(org_id) and created_by = auth.uid());
create policy "editors update" on public.workflows for update to authenticated
  using (private.can_edit(org_id)) with check (private.can_edit(org_id));
create policy "admins delete" on public.workflows for delete to authenticated using (private.can_admin(org_id));

create policy "members read" on public.workflow_versions for select to authenticated using (private.is_member(org_id));
create policy "editors publish" on public.workflow_versions for insert to authenticated with check (
  published_by = auth.uid()
  and exists (select 1 from public.workflows w where w.id = workflow_id and private.can_edit(w.org_id))
);

create policy "members read" on public.executions for select to authenticated using (private.is_member(org_id));
create policy "members read" on public.execution_steps for select to authenticated using (private.is_member(org_id));
create policy "members read" on public.approvals for select to authenticated using (private.is_member(org_id));
create policy "members read" on public.execution_logs for select to authenticated using (private.is_member(org_id));
create policy "admins read" on public.audit_events for select to authenticated using (private.can_admin(org_id));

-- Engine-owned tables: no client writes at all, whatever the policies say.
revoke insert, update, delete, truncate on public.executions, public.execution_steps, public.approvals,
  public.execution_logs, public.audit_events from anon, authenticated;
-- Editors may only change these workflow columns (org/ownership are fixed).
revoke update on public.workflows from authenticated;
grant update (name, description, draft_graph) on public.workflows to authenticated;
revoke all on all tables in schema public from anon;
revoke all on private.local_credentials from anon, authenticated;

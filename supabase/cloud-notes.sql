-- Cloud notes + collaboration schema for Noto
-- Run this in Supabase SQL editor for project hrsjiejhvrlfjuzbxzgv

create extension if not exists "pgcrypto";

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  owner_email text,
  title text not null,
  content text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notes
  add column if not exists owner_email text;

alter table public.notes
  add column if not exists storage_bucket text;

alter table public.notes
  add column if not exists storage_path text;

alter table public.notes
  add column if not exists content_size bigint not null default 0;

create index if not exists notes_owner_idx on public.notes (owner_id);
create index if not exists notes_storage_path_idx on public.notes (storage_path);

create table if not exists public.note_collaborators (
  note_id uuid not null references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  collaborator_email text,
  role text not null default 'editor',
  created_at timestamptz not null default now(),
  primary key (note_id, user_id)
);

alter table public.note_collaborators
  add column if not exists collaborator_email text;

create index if not exists note_collaborators_email_idx on public.note_collaborators (collaborator_email);

create table if not exists public.note_invites (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  invited_email text not null,
  invited_by uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

alter table public.note_invites
  add column if not exists role text not null default 'editor';

alter table public.note_invites
  add column if not exists note_title text;

alter table public.note_invites
  add column if not exists invited_by_email text;

alter table public.note_invites
  add column if not exists invited_by_name text;

update public.note_invites i
set
  note_title = coalesce(i.note_title, n.title),
  invited_by_email = coalesce(i.invited_by_email, n.owner_email)
from public.notes n
where n.id = i.note_id;

create index if not exists note_invites_email_idx on public.note_invites (invited_email);
create unique index if not exists note_invites_unique on public.note_invites (note_id, invited_email);

create table if not exists public.note_presence (
  note_id uuid not null references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  last_seen timestamptz not null default now(),
  primary key (note_id, user_id)
);

alter table public.note_presence
  add column if not exists user_email text;

create index if not exists note_presence_note_idx on public.note_presence (note_id);

create or replace function public.is_note_collaborator(note_uuid uuid)
returns boolean
language sql
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.note_collaborators c
    where c.note_id = note_uuid
      and c.user_id = auth.uid()
  );
$$;

create or replace function public.is_note_owner(note_uuid uuid)
returns boolean
language sql
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.notes n
    where n.id = note_uuid
      and n.owner_id = auth.uid()
  );
$$;

create or replace function public.is_note_admin(note_uuid uuid)
returns boolean
language sql
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.notes n
    where n.id = note_uuid
      and n.owner_id = auth.uid()
  )
  or exists (
    select 1
    from public.note_collaborators c
    where c.note_id = note_uuid
      and c.user_id = auth.uid()
      and lower(c.role) = 'admin'
  );
$$;

create or replace function public.is_note_editor(note_uuid uuid)
returns boolean
language sql
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.notes n
    where n.id = note_uuid
      and n.owner_id = auth.uid()
  )
  or exists (
    select 1
    from public.note_collaborators c
    where c.note_id = note_uuid
      and c.user_id = auth.uid()
      and lower(c.role) in ('admin', 'editor')
  );
$$;

grant execute on function public.is_note_collaborator(uuid) to anon, authenticated;
grant execute on function public.is_note_owner(uuid) to anon, authenticated;
grant execute on function public.is_note_admin(uuid) to anon, authenticated;
grant execute on function public.is_note_editor(uuid) to anon, authenticated;

create or replace function public.list_my_note_invites()
returns table (
  id uuid,
  note_id uuid,
  status text,
  role text,
  created_at timestamptz,
  invited_email text,
  invited_by uuid,
  note_title text,
  invited_by_email text,
  invited_by_name text
)
language sql
security definer
set search_path = public, auth
set row_security = off
as $$
  select
    i.id,
    i.note_id,
    i.status,
    i.role,
    i.created_at,
    i.invited_email,
    i.invited_by,
    coalesce(nullif(i.note_title, ''), n.title, 'Shared note') as note_title,
    coalesce(nullif(i.invited_by_email, ''), n.owner_email, '') as invited_by_email,
    coalesce(nullif(i.invited_by_name, ''), '') as invited_by_name
  from public.note_invites i
  left join public.notes n on n.id = i.note_id
  where i.status = 'pending'
    and lower(coalesce(i.invited_email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
  order by i.created_at desc;
$$;

grant execute on function public.list_my_note_invites() to authenticated;

create or replace function public.note_id_from_storage_object_name(object_name text)
returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  candidate text;
begin
  candidate := split_part(coalesce(object_name, ''), '/', 2);
  if lower(candidate) = 'collaborations' then
    candidate := split_part(coalesce(object_name, ''), '/', 3);
  end if;
  if lower(candidate) = 'users' then
    return null;
  end if;
  if candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return candidate::uuid;
  end if;
  return null;
end;
$$;

grant execute on function public.note_id_from_storage_object_name(text) to anon, authenticated;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_notes_updated_at on public.notes;
create trigger set_notes_updated_at
before update on public.notes
for each row execute function public.set_updated_at();

alter table public.notes enable row level security;
alter table public.note_collaborators enable row level security;
alter table public.note_invites enable row level security;
alter table public.note_presence enable row level security;

insert into storage.buckets (id, name, public)
values ('noto-cloud-notes', 'noto-cloud-notes', false)
on conflict (id) do nothing;

-- Notes policies
drop policy if exists "Notes are viewable by owner or collaborators" on public.notes;
create policy "Notes are viewable by owner or collaborators"
on public.notes
for select
using (
  owner_id = auth.uid()
  or public.is_note_collaborator(id)
);

drop policy if exists "Owners can insert notes" on public.notes;
create policy "Owners can insert notes"
on public.notes
for insert
with check (
  owner_id = auth.uid()
  and lower(coalesce(owner_email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
);

drop policy if exists "Owners or collaborators can update notes" on public.notes;
create policy "Owners or collaborators can update notes"
on public.notes
for update
using (
  public.is_note_editor(id)
)
with check (
  public.is_note_editor(id)
);

drop policy if exists "Owners can delete notes" on public.notes;
create policy "Owners can delete notes"
on public.notes
for delete
using (public.is_note_admin(id));

-- Supabase Storage object policies for note files
drop policy if exists "Personal cloud files selectable by owner" on storage.objects;
create policy "Personal cloud files selectable by owner"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'noto-cloud-notes'
  and split_part(name, '/', 1) = 'notes'
  and split_part(name, '/', 2) = 'users'
  and split_part(name, '/', 3) = auth.uid()::text
);

drop policy if exists "Personal cloud files insertable by owner" on storage.objects;
create policy "Personal cloud files insertable by owner"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'noto-cloud-notes'
  and split_part(name, '/', 1) = 'notes'
  and split_part(name, '/', 2) = 'users'
  and split_part(name, '/', 3) = auth.uid()::text
);

drop policy if exists "Personal cloud files updatable by owner" on storage.objects;
create policy "Personal cloud files updatable by owner"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'noto-cloud-notes'
  and split_part(name, '/', 1) = 'notes'
  and split_part(name, '/', 2) = 'users'
  and split_part(name, '/', 3) = auth.uid()::text
)
with check (
  bucket_id = 'noto-cloud-notes'
  and split_part(name, '/', 1) = 'notes'
  and split_part(name, '/', 2) = 'users'
  and split_part(name, '/', 3) = auth.uid()::text
);

drop policy if exists "Personal cloud files deletable by owner" on storage.objects;
create policy "Personal cloud files deletable by owner"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'noto-cloud-notes'
  and split_part(name, '/', 1) = 'notes'
  and split_part(name, '/', 2) = 'users'
  and split_part(name, '/', 3) = auth.uid()::text
);

drop policy if exists "Note files selectable by collaborators" on storage.objects;
create policy "Note files selectable by collaborators"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'noto-cloud-notes'
  and public.note_id_from_storage_object_name(name) is not null
  and (
    public.is_note_owner(public.note_id_from_storage_object_name(name))
    or public.is_note_collaborator(public.note_id_from_storage_object_name(name))
  )
);

drop policy if exists "Note files insertable by editors" on storage.objects;
create policy "Note files insertable by editors"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'noto-cloud-notes'
  and public.note_id_from_storage_object_name(name) is not null
  and public.is_note_editor(public.note_id_from_storage_object_name(name))
);

drop policy if exists "Note files updatable by editors" on storage.objects;
create policy "Note files updatable by editors"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'noto-cloud-notes'
  and public.note_id_from_storage_object_name(name) is not null
  and public.is_note_editor(public.note_id_from_storage_object_name(name))
)
with check (
  bucket_id = 'noto-cloud-notes'
  and public.note_id_from_storage_object_name(name) is not null
  and public.is_note_editor(public.note_id_from_storage_object_name(name))
);

drop policy if exists "Note files deletable by admins" on storage.objects;
create policy "Note files deletable by admins"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'noto-cloud-notes'
  and public.note_id_from_storage_object_name(name) is not null
  and public.is_note_admin(public.note_id_from_storage_object_name(name))
);

-- Collaborators policies
drop policy if exists "Collaborators viewable by owner or collaborator" on public.note_collaborators;
create policy "Collaborators viewable by owner or collaborator"
on public.note_collaborators
for select
using (
  public.is_note_owner(note_id)
  or public.is_note_collaborator(note_id)
);

drop policy if exists "Invited users can accept collaboration" on public.note_collaborators;
create policy "Invited users can accept collaboration"
on public.note_collaborators
for insert
with check (
  user_id = auth.uid()
  and lower(coalesce(collaborator_email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
  and exists (
    select 1 from public.note_invites i
    where i.note_id = note_id
      and i.status = 'pending'
      and lower(i.invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and lower(i.role) = lower(coalesce(role, 'editor'))
  )
);

drop policy if exists "Owners can add collaborators" on public.note_collaborators;
create policy "Owners can add collaborators"
on public.note_collaborators
for insert
with check (
  public.is_note_admin(note_id)
  and lower(coalesce(collaborator_email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
);

drop policy if exists "Admins can update collaborator roles" on public.note_collaborators;
create policy "Admins can update collaborator roles"
on public.note_collaborators
for update
using (public.is_note_admin(note_id))
with check (public.is_note_admin(note_id));

drop policy if exists "Owners can remove collaborators" on public.note_collaborators;
create policy "Owners can remove collaborators"
on public.note_collaborators
for delete
using (
  public.is_note_admin(note_id)
  or user_id = auth.uid()
);

-- Invites policies
drop policy if exists "Owners can insert invites" on public.note_invites;
create policy "Owners can insert invites"
on public.note_invites
for insert
with check (
  public.is_note_admin(note_id)
);

drop policy if exists "Invitees and owners can view invites" on public.note_invites;
create policy "Invitees and owners can view invites"
on public.note_invites
for select
using (
  lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  or public.is_note_admin(note_id)
);

drop policy if exists "Invitees can update invites" on public.note_invites;
create policy "Invitees can update invites"
on public.note_invites
for update
using (
  lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
)
with check (
  lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
);

drop policy if exists "Admins can update invites" on public.note_invites;
create policy "Admins can update invites"
on public.note_invites
for update
using (public.is_note_admin(note_id))
with check (public.is_note_admin(note_id));

-- Presence policies
drop policy if exists "Presence viewable by owner or collaborators" on public.note_presence;
create policy "Presence viewable by owner or collaborators"
on public.note_presence
for select
using (
  public.is_note_owner(note_id)
  or public.is_note_collaborator(note_id)
);

drop policy if exists "Users can upsert their presence" on public.note_presence;
create policy "Users can upsert their presence"
on public.note_presence
for insert
with check (
  user_id = auth.uid()
  and (public.is_note_owner(note_id) or public.is_note_collaborator(note_id))
);

drop policy if exists "Users can update their presence" on public.note_presence;
create policy "Users can update their presence"
on public.note_presence
for update
using (
  user_id = auth.uid()
  and (public.is_note_owner(note_id) or public.is_note_collaborator(note_id))
)
with check (
  user_id = auth.uid()
  and (public.is_note_owner(note_id) or public.is_note_collaborator(note_id))
);

drop policy if exists "Users can clear their presence" on public.note_presence;
create policy "Users can clear their presence"
on public.note_presence
for delete
using (
  user_id = auth.uid()
  and (public.is_note_owner(note_id) or public.is_note_collaborator(note_id))
);

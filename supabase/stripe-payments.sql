-- Stripe payment gate schema for Noto
-- Run this in the Supabase SQL editor for project hrsjiejhvrlfjuzbxzgv

create table if not exists public.app_payments (
  device_id text primary key,
  payment_status text not null default 'unpaid',
  paid_at timestamptz,
  livemode boolean not null default false,
  checkout_session_id text,
  payment_link_id text,
  customer_email text,
  currency text,
  amount_total bigint,
  raw_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists app_payments_checkout_session_id_idx
  on public.app_payments (checkout_session_id)
  where checkout_session_id is not null;

create unique index if not exists app_payments_raw_event_id_idx
  on public.app_payments (raw_event_id)
  where raw_event_id is not null;

create or replace function public.set_app_payments_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_app_payments_updated_at on public.app_payments;
create trigger set_app_payments_updated_at
before update on public.app_payments
for each row execute function public.set_app_payments_updated_at();

alter table public.app_payments enable row level security;

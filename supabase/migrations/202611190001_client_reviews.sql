-- Client reviews for Malkiaa Studio.
-- Apply this migration ONLY to the STAGING Supabase project.
begin;

create table if not exists public.client_reviews (
  id uuid primary key default gen_random_uuid(),
  commission_id text not null unique references public.commission_requests(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  message text not null check (char_length(message) between 10 and 1200),
  display_name text not null default 'Anonymous',
  is_anonymous boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'approved', 'hidden')),
  created_at timestamptz not null default now(),
  moderated_at timestamptz
);

create index if not exists client_reviews_public_idx
  on public.client_reviews (status, created_at desc);

alter table public.client_reviews enable row level security;
revoke all on public.client_reviews from anon, authenticated;
grant all on public.client_reviews to service_role;

commit;

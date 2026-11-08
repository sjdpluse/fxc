-- FXC owns only the fxc_* objects below. Existing applications are unchanged.
create table public.fxc_journals (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision between 0 and 9007199254740990),
  time_zone text not null default 'Asia/Kabul' check (char_length(time_zone) between 1 and 100),
  updated_at timestamptz not null default now()
);

create table public.fxc_trades (
  user_id uuid not null references public.fxc_journals(user_id) on delete cascade,
  id text not null check (id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  trade_date date not null check (trade_date between date '1900-01-01' and date '2100-12-31'),
  symbol text not null check (symbol ~ '^[A-Z0-9][A-Z0-9 ./_-]{0,19}$'),
  direction text not null check (direction in ('long', 'short')),
  gross_cents bigint not null check (gross_cents between -100000000000 and 100000000000),
  fee_cents bigint not null check (fee_cents between 0 and 100000000000),
  notes text not null default '' check (char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index fxc_trades_user_date_idx on public.fxc_trades(user_id, trade_date);

alter table public.fxc_journals enable row level security;
alter table public.fxc_trades enable row level security;
revoke all on public.fxc_journals, public.fxc_trades from public, anon, authenticated;
grant select, insert, update, delete on public.fxc_journals, public.fxc_trades to authenticated;

create policy fxc_journals_select_own on public.fxc_journals for select to authenticated using ((select auth.uid()) = user_id);
create policy fxc_journals_insert_own on public.fxc_journals for insert to authenticated with check ((select auth.uid()) = user_id);
create policy fxc_journals_update_own on public.fxc_journals for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy fxc_journals_delete_own on public.fxc_journals for delete to authenticated using ((select auth.uid()) = user_id);
create policy fxc_trades_select_own on public.fxc_trades for select to authenticated using ((select auth.uid()) = user_id);
create policy fxc_trades_insert_own on public.fxc_trades for insert to authenticated with check ((select auth.uid()) = user_id);
create policy fxc_trades_update_own on public.fxc_trades for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy fxc_trades_delete_own on public.fxc_trades for delete to authenticated using ((select auth.uid()) = user_id);

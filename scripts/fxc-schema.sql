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

create function public.fxc_load_journal()
returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $function$
declare
  owner_id uuid := auth.uid();
  result jsonb;
begin
  if owner_id is null then raise exception 'Sign in to access your journal.' using errcode = '42501'; end if;
  select jsonb_build_object(
    'revision', coalesce(j.revision, 0),
    'journal', jsonb_build_object(
      'version', 1,
      'settings', jsonb_build_object('timeZone', coalesce(j.time_zone, 'Asia/Kabul')),
      'trades', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'date', to_char(t.trade_date, 'YYYY-MM-DD'), 'symbol', t.symbol,
        'direction', t.direction, 'grossCents', t.gross_cents, 'feeCents', t.fee_cents, 'notes', t.notes
      ) order by t.trade_date, t.id) from public.fxc_trades t where t.user_id = owner_id), '[]'::jsonb)
    )
  ) into result from (select owner_id as id) actor left join public.fxc_journals j on j.user_id = actor.id;
  return result;
end;
$function$;

create function public.fxc_save_journal(p_expected_revision bigint, p_journal jsonb)
returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $function$
declare
  owner_id uuid := auth.uid();
  current_revision bigint;
  next_zone text;
begin
  if owner_id is null then raise exception 'Sign in to save your journal.' using errcode = '42501'; end if;
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid journal revision.' using errcode = '22023'; end if;
  if jsonb_typeof(p_journal) is distinct from 'object'
     or p_journal->'version' is distinct from '1'::jsonb
     or jsonb_typeof(p_journal->'trades') is distinct from 'array'
     or jsonb_typeof(p_journal->'settings') is distinct from 'object'
     or jsonb_typeof(p_journal->'settings'->'timeZone') is distinct from 'string' then
    raise exception 'Invalid FXC journal.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_journal->'trades') > 10000 then raise exception 'Maximum 10,000 trades per journal.' using errcode = '22023'; end if;
  next_zone := p_journal->'settings'->>'timeZone';
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = next_zone) then raise exception 'Invalid journal timezone.' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_journal->'trades') entry where
      jsonb_typeof(entry) is distinct from 'object'
      or jsonb_typeof(entry->'id') is distinct from 'string'
      or jsonb_typeof(entry->'date') is distinct from 'string'
      or jsonb_typeof(entry->'symbol') is distinct from 'string'
      or jsonb_typeof(entry->'direction') is distinct from 'string'
      or jsonb_typeof(entry->'grossCents') is distinct from 'number'
      or jsonb_typeof(entry->'feeCents') is distinct from 'number'
      or jsonb_typeof(entry->'notes') is distinct from 'string'
      or (entry->>'date') !~ '^\d{4}-\d{2}-\d{2}$'
      or (entry->>'grossCents') !~ '^-?[0-9]+$'
      or (entry->>'feeCents') !~ '^[0-9]+$') then
    raise exception 'Invalid trade data.' using errcode = '22023';
  end if;
  if (select count(*) <> count(distinct entry->>'id') from jsonb_array_elements(p_journal->'trades') entry) then
    raise exception 'Duplicate trade IDs.' using errcode = '22023';
  end if;

  insert into public.fxc_journals(user_id) values (owner_id) on conflict (user_id) do nothing;
  select revision into current_revision from public.fxc_journals where user_id = owner_id for update;
  if current_revision <> p_expected_revision then
    raise exception 'FXC_CONFLICT: Journal changed on another device. Refresh cloud data and review your changes.' using errcode = '40001';
  end if;

  insert into public.fxc_trades(user_id, id, trade_date, symbol, direction, gross_cents, fee_cents, notes)
  select owner_id, entry->>'id', (entry->>'date')::date, entry->>'symbol', entry->>'direction',
    (entry->>'grossCents')::bigint, (entry->>'feeCents')::bigint, entry->>'notes'
  from jsonb_array_elements(p_journal->'trades') entry
  on conflict (user_id, id) do update set trade_date=excluded.trade_date, symbol=excluded.symbol,
    direction=excluded.direction, gross_cents=excluded.gross_cents, fee_cents=excluded.fee_cents, notes=excluded.notes;
  delete from public.fxc_trades t where t.user_id = owner_id
    and not exists (select 1 from jsonb_array_elements(p_journal->'trades') entry where entry->>'id' = t.id);
  update public.fxc_journals set revision = current_revision + 1, time_zone = next_zone, updated_at = now() where user_id = owner_id;
  return public.fxc_load_journal();
end;
$function$;

revoke all on function public.fxc_load_journal() from public, anon, authenticated;
revoke all on function public.fxc_save_journal(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.fxc_load_journal(), public.fxc_save_journal(bigint, jsonb) to authenticated;
comment on table public.fxc_journals is 'FXC preferences and optimistic concurrency revision; private per Auth user.';
comment on table public.fxc_trades is 'FXC closed trades; integer USD cents, isolated per Auth user.';
notify pgrst, 'reload schema';

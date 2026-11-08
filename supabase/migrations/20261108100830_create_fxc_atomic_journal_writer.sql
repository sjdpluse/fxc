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


revoke all on function public.fxc_save_journal(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.fxc_save_journal(bigint, jsonb) to authenticated;
notify pgrst, 'reload schema';

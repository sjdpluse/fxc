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


revoke all on function public.fxc_load_journal() from public, anon, authenticated;
grant execute on function public.fxc_load_journal() to authenticated;

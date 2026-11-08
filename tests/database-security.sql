-- Integration assertions against the deployed FXC schema.
-- Disposable users and test records exist only inside this rolled-back transaction.
begin;
do $test$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  actual jsonb;
  denied boolean;
  sample jsonb := '{"version":1,"settings":{"timeZone":"Asia/Kabul"},"trades":[{"id":"fxc_test","date":"2026-11-08","symbol":"XAUUSD","direction":"long","grossCents":25000,"feeCents":500,"notes":"FXC transaction-only test"}]}'::jsonb;
begin
  insert into auth.users(id) values(user_a), (user_b);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', user_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',user_a,'role','authenticated')::text, true);
  actual := public.fxc_load_journal();
  if (actual->>'revision')::bigint <> 0 then raise exception 'Empty journal revision is incorrect'; end if;
  actual := public.fxc_save_journal(0, sample);
  if (actual->>'revision')::bigint <> 1 or jsonb_array_length(actual->'journal'->'trades') <> 1 then raise exception 'Save did not return the committed journal'; end if;
  if actual->'journal'->'trades'->0->>'grossCents' <> '25000' then raise exception 'Cents did not round-trip'; end if;
  denied := false;
  begin perform public.fxc_save_journal(0, sample); exception when serialization_failure then denied := true; end;
  if not denied then raise exception 'A stale device overwrote a newer revision'; end if;
  denied := false;
  begin perform public.fxc_save_journal(1, jsonb_set(sample,'{trades,0,date}','"2026-02-30"')); exception when datetime_field_overflow then denied := true; end;
  if not denied then raise exception 'Invalid date was accepted'; end if;
  actual := public.fxc_load_journal();
  if (actual->>'revision')::bigint <> 1 or jsonb_array_length(actual->'journal'->'trades') <> 1 then raise exception 'Failed transaction changed saved data'; end if;

  perform set_config('request.jwt.claim.sub', user_b::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',user_b,'role','authenticated')::text, true);
  actual := public.fxc_load_journal();
  if jsonb_array_length(actual->'journal'->'trades') <> 0 then raise exception 'User B read User A journal'; end if;
  if exists(select 1 from public.fxc_trades where user_id=user_a) then raise exception 'RLS did not hide another owner'; end if;
  denied := false;
  begin
    insert into public.fxc_trades(user_id,id,trade_date,symbol,direction,gross_cents,fee_cents,notes)
    values(user_a,'intrusion','2026-11-08','US100','short',1,0,'');
  exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'User B inserted a trade for User A'; end if;
  update public.fxc_trades set notes='intrusion' where user_id=user_a;
  delete from public.fxc_trades where user_id=user_a;
  actual := public.fxc_save_journal(0, jsonb_set(sample,'{trades,0,id}','"user_b_trade"'));
  if (actual->>'revision')::bigint <> 1 then raise exception 'User B could not create own journal'; end if;

  perform set_config('request.jwt.claim.sub', user_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',user_a,'role','authenticated')::text, true);
  actual := public.fxc_load_journal();
  if actual->'journal'->'trades'->0->>'notes' <> 'FXC transaction-only test' then raise exception 'Another user changed owner data'; end if;
  denied := false;
  begin update public.fxc_trades set user_id=user_b where user_id=user_a; exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'User could reassign a trade to another owner'; end if;
  actual := public.fxc_save_journal(1, jsonb_set(sample,'{trades}','[]'));
  if (actual->>'revision')::bigint <> 2 or jsonb_array_length(actual->'journal'->'trades') <> 0 then raise exception 'Deletion did not persist atomically'; end if;

  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  denied := false;
  begin perform public.fxc_load_journal(); exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'Anonymous user executed a private function'; end if;
  denied := false;
  begin perform count(*) from public.fxc_trades; exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'Anonymous user read a private table'; end if;
end;
$test$;
reset role;
rollback;
select 'FXC RLS, transactions, validation, and concurrency assertions passed; test data rolled back.' as verification;

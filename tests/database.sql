\set ON_ERROR_STOP on
begin;
do $$
begin
  if has_table_privilege('anon','public.health_records','select') or has_table_privilege('authenticated','public.care_members','select')
     or has_function_privilege('anon','public.care_api(text,text,jsonb)','execute')
     or has_function_privilege('authenticated','public.care_api(text,text,jsonb)','execute') then
    raise exception 'public database access is enabled';
  end if;
end $$;
insert into public.care_members(line_user_id,display_name,is_admin) values
('U00000000000000000000000000000001','Admin',true),
('U00000000000000000000000000000002','Member',false);
set local role service_role;
do $$
declare admin_id text='U00000000000000000000000000000001'; member_id text='U00000000000000000000000000000002'; state jsonb; result jsonb;
begin
  result := public.care_api('U00000000000000000000000000000003','state','{}');
  if result->>'error' <> 'forbidden' then raise exception 'non-member was allowed'; end if;
  result := public.care_api(member_id,'members','{}');
  if result->>'error' <> 'forbidden' then raise exception 'non-admin can list members'; end if;
  begin
    perform public.care_api(admin_id,'member_remove',jsonb_build_object('userId',admin_id));
    raise exception 'removed last admin';
  exception when invalid_parameter_value then null; end;
  perform public.care_api(admin_id,'member_save',jsonb_build_object('userId','U00000000000000000000000000000003','name','New','isAdmin',false));
  perform public.care_api(member_id,'record_add','{"id":"10000000-0000-4000-8000-000000000001","measuredAt":"2026-01-01T10:00:00Z","systolic":120,"diastolic":80,"pulse":null,"spo2":null,"temperature":null,"period":"","note":"","photo":""}');
  perform public.care_api(member_id,'record_add','{"id":"10000000-0000-4000-8000-000000000001","measuredAt":"2026-01-01T10:00:00Z","systolic":120,"diastolic":80,"pulse":null,"spo2":null,"temperature":null,"period":"","note":"","photo":""}');
  begin
    perform public.care_api(member_id,'record_add','{"id":"10000000-0000-4000-8000-000000000001","measuredAt":"2026-01-01T10:00:00Z","systolic":130,"diastolic":80,"pulse":null,"spo2":null,"temperature":null,"period":"","note":"","photo":""}');
    raise exception 'conflicting retry accepted';
  exception when invalid_parameter_value then null; end;
  perform public.care_api(admin_id,'check_set','{"day":"2026-01-01","item":"breakfast","done":true}');
  perform public.care_api(member_id,'log_add','{"id":"10000000-0000-4000-8000-000000000002","text":"water","photo":""}');
  perform public.care_api(member_id,'comment_add','{"id":"10000000-0000-4000-8000-000000000003","targetId":"10000000-0000-4000-8000-000000000001","targetType":"record","text":"thanks"}');
  perform public.care_api(member_id,'reaction_set','{"targetId":"10000000-0000-4000-8000-000000000001","targetType":"record","kind":"thanks","selected":true}');
  state := public.care_api(member_id,'state','{}');
  if jsonb_array_length(state->'records') <> 1 or state#>>'{checklists,2026-01-01,breakfast}' <> 'true' or state#>>'{reactions,10000000-0000-4000-8000-000000000001,thanks}' <> 'true' then raise exception 'state mismatch: %',state; end if;
  if jsonb_array_length(state#>'{comments,10000000-0000-4000-8000-000000000001}') <> 1 then raise exception 'comment missing'; end if;
  state := public.care_api(admin_id,'state','{}');
  if state#>'{reactions,10000000-0000-4000-8000-000000000001}' is not null then raise exception 'reaction leaked across users'; end if;
  perform public.care_api(member_id,'reaction_set','{"targetId":"10000000-0000-4000-8000-000000000001","targetType":"record","kind":"thanks","selected":false}');
  perform public.care_api(member_id,'medicine_add','{"id":"10000000-0000-4000-8000-000000000004","name":"Medicine","timing":"飯後","dose":"1","photo":""}');
  perform public.care_api(admin_id,'appointment_save','{"date":"2026-02-01","department":"Clinic","instructions":"Bring notes"}');
  state := public.care_api(admin_id,'medicine_remove','{"id":"10000000-0000-4000-8000-000000000004"}');
  if jsonb_array_length(state->'medicines') <> 0 or state#>>'{appointment,department}' <> 'Clinic' then raise exception 'care info mismatch'; end if;
  perform public.care_api(admin_id,'member_remove',jsonb_build_object('userId',member_id));
  if public.care_api(member_id,'state','{}')->>'error' <> 'forbidden' then raise exception 'revoked member retained access'; end if;
end $$;
rollback;

-- Run once in the Supabase SQL editor. No public client policies are installed.
create extension if not exists pgcrypto;

create table public.care_members (
  line_user_id text primary key check (line_user_id ~ '^U[0-9a-f]{32}$'),
  display_name text not null check (length(trim(display_name)) between 1 and 80),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.health_records (
  id uuid primary key,
  measured_at timestamptz not null,
  systolic integer check (systolic between 40 and 300),
  diastolic integer check (diastolic between 20 and 200),
  pulse integer check (pulse between 20 and 250),
  spo2 integer check (spo2 between 50 and 100),
  temperature numeric(3,1) check (temperature between 30 and 45),
  period text not null default '' check (period in ('','早上','下午','睡前','不適時')),
  note text not null default '' check (length(note) <= 500),
  photo text not null default '' check (length(photo) <= 1400000),
  created_by text not null,
  created_at timestamptz not null default now(),
  check ((systolic is null) = (diastolic is null)),
  check (systolic is null or systolic > diastolic),
  check (systolic is not null or pulse is not null or spo2 is not null or temperature is not null)
);
create index health_records_measured_at_idx on public.health_records (measured_at desc);

create table public.daily_checklists (
  day date not null,
  item text not null check (item in ('breakfast','lunch','dinner','morningMedicine','eveningMedicine','bowel')),
  done boolean not null,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (day,item)
);
create table public.care_logs (
  id uuid primary key,
  created_at timestamptz not null default now(),
  text text not null check (length(trim(text)) between 1 and 500),
  photo text not null default '' check (length(photo) <= 1400000),
  created_by text not null
);
create table public.comments (
  id uuid primary key,
  target_type text not null check (target_type in ('record','log')),
  target_id uuid not null,
  text text not null check (length(trim(text)) between 1 and 200),
  created_at timestamptz not null default now(),
  created_by text not null
);
create table public.reactions (
  target_type text not null check (target_type in ('record','log')),
  target_id uuid not null,
  kind text not null check (kind in ('thanks','seen')),
  line_user_id text not null,
  primary key (target_type,target_id,kind,line_user_id)
);
create table public.medications (
  id uuid primary key,
  name text not null check (length(trim(name)) between 1 and 80),
  timing text not null check (timing in ('飯前','飯後','睡前','依醫囑')),
  dose text not null check (length(trim(dose)) between 1 and 80),
  photo text not null default '' check (length(photo) <= 1400000),
  created_by text not null,
  created_at timestamptz not null default now()
);
create table public.appointment (
  id integer primary key default 1 check (id=1),
  date date not null,
  department text not null check (length(trim(department)) between 1 and 100),
  instructions text not null default '' check (length(instructions) <= 500),
  updated_by text not null
);

alter table public.care_members enable row level security;
alter table public.health_records enable row level security;
alter table public.daily_checklists enable row level security;
alter table public.care_logs enable row level security;
alter table public.comments enable row level security;
alter table public.reactions enable row level security;
alter table public.medications enable row level security;
alter table public.appointment enable row level security;
revoke all on public.care_members, public.health_records, public.daily_checklists, public.care_logs, public.comments, public.reactions, public.medications, public.appointment from public, anon, authenticated;
grant select, insert, update, delete on public.care_members, public.health_records, public.daily_checklists, public.care_logs, public.comments, public.reactions, public.medications, public.appointment to service_role;

create function public.care_api(p_actor text, p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  member_row public.care_members%rowtype;
  v_target_type text;
  v_target_id uuid;
  target_member public.care_members%rowtype;
  result jsonb;
begin
  -- Serialize membership changes against all authorized operations, including revocation.
  perform pg_advisory_xact_lock(882014);
  select * into member_row from public.care_members where line_user_id=p_actor;
  if not found then return jsonb_build_object('error','forbidden'); end if;

  case p_action
  when 'session' then
    return jsonb_build_object('userId',p_actor,'displayName',member_row.display_name,'isAdmin',member_row.is_admin);
  when 'members' then
    if not member_row.is_admin then return jsonb_build_object('error','forbidden'); end if;
    return coalesce((select jsonb_agg(jsonb_build_object('userId',line_user_id,'name',display_name,'isAdmin',is_admin) order by created_at) from public.care_members),'[]'::jsonb);
  when 'member_save' then
    if not member_row.is_admin then return jsonb_build_object('error','forbidden'); end if;
    if coalesce(p_payload->>'userId','') !~ '^U[0-9a-f]{32}$' or length(trim(coalesce(p_payload->>'name',''))) not between 1 and 80 or jsonb_typeof(p_payload->'isAdmin') <> 'boolean' then
      raise exception 'invalid member' using errcode='22023';
    end if;
    select * into target_member from public.care_members where line_user_id=p_payload->>'userId';
    if found and target_member.is_admin and not (p_payload->>'isAdmin')::boolean and (select count(*) from public.care_members where is_admin)=1 then
      raise exception 'last admin' using errcode='22023';
    end if;
    insert into public.care_members(line_user_id,display_name,is_admin) values(p_payload->>'userId',trim(p_payload->>'name'),(p_payload->>'isAdmin')::boolean)
    on conflict(line_user_id) do update set display_name=excluded.display_name,is_admin=excluded.is_admin;
    return jsonb_build_object('ok',true);
  when 'member_remove' then
    if not member_row.is_admin then return jsonb_build_object('error','forbidden'); end if;
    select * into target_member from public.care_members where line_user_id=p_payload->>'userId';
    if not found then raise exception 'member not found' using errcode='22023'; end if;
    if target_member.is_admin and (select count(*) from public.care_members where is_admin)=1 then raise exception 'last admin' using errcode='22023'; end if;
    delete from public.care_members where line_user_id=target_member.line_user_id;
    return jsonb_build_object('ok',true);
  when 'record_add' then
    insert into public.health_records(id,measured_at,systolic,diastolic,pulse,spo2,temperature,period,note,photo,created_by)
    values((p_payload->>'id')::uuid,(p_payload->>'measuredAt')::timestamptz,(p_payload->>'systolic')::integer,(p_payload->>'diastolic')::integer,
      (p_payload->>'pulse')::integer,(p_payload->>'spo2')::integer,(p_payload->>'temperature')::numeric,
      coalesce(p_payload->>'period',''),coalesce(p_payload->>'note',''),coalesce(p_payload->>'photo',''),p_actor)
    on conflict(id) do nothing;
    if not found and not exists(select 1 from public.health_records where id=(p_payload->>'id')::uuid and created_by=p_actor and measured_at=(p_payload->>'measuredAt')::timestamptz and systolic is not distinct from (p_payload->>'systolic')::integer and diastolic is not distinct from (p_payload->>'diastolic')::integer and pulse is not distinct from (p_payload->>'pulse')::integer and spo2 is not distinct from (p_payload->>'spo2')::integer and temperature is not distinct from (p_payload->>'temperature')::numeric and period=coalesce(p_payload->>'period','') and note=coalesce(p_payload->>'note','') and photo=coalesce(p_payload->>'photo','')) then
      raise exception 'conflicting retry' using errcode='22023';
    end if;
  when 'check_set' then
    insert into public.daily_checklists(day,item,done,updated_by)
    values((p_payload->>'day')::date,p_payload->>'item',(p_payload->>'done')::boolean,p_actor)
    on conflict(day,item) do update set done=excluded.done,updated_by=p_actor,updated_at=now();
  when 'log_add' then
    insert into public.care_logs(id,text,photo,created_by) values((p_payload->>'id')::uuid,trim(p_payload->>'text'),coalesce(p_payload->>'photo',''),p_actor) on conflict(id) do nothing;
    if not found and not exists(select 1 from public.care_logs where id=(p_payload->>'id')::uuid and created_by=p_actor and text=trim(p_payload->>'text') and photo=coalesce(p_payload->>'photo','')) then raise exception 'conflicting retry' using errcode='22023'; end if;
  when 'comment_add','reaction_set' then
    v_target_type=p_payload->>'targetType'; v_target_id=(p_payload->>'targetId')::uuid;
    if not ((v_target_type='record' and exists(select 1 from public.health_records where id=v_target_id)) or (v_target_type='log' and exists(select 1 from public.care_logs where id=v_target_id))) then raise exception 'invalid target' using errcode='22023'; end if;
    if p_action='comment_add' then
      insert into public.comments(id,target_type,target_id,text,created_by) values((p_payload->>'id')::uuid,v_target_type,v_target_id,trim(p_payload->>'text'),p_actor) on conflict(id) do nothing;
      if not found and not exists(select 1 from public.comments where id=(p_payload->>'id')::uuid and created_by=p_actor and target_type=v_target_type and target_id=v_target_id and text=trim(p_payload->>'text')) then raise exception 'conflicting retry' using errcode='22023'; end if;
    elsif (p_payload->>'selected')::boolean then
      insert into public.reactions(target_type,target_id,kind,line_user_id) values(v_target_type,v_target_id,p_payload->>'kind',p_actor) on conflict do nothing;
    else
      delete from public.reactions where target_type=v_target_type and target_id=v_target_id and kind=p_payload->>'kind' and line_user_id=p_actor;
    end if;
  when 'medicine_add' then
    insert into public.medications(id,name,timing,dose,photo,created_by) values((p_payload->>'id')::uuid,trim(p_payload->>'name'),p_payload->>'timing',trim(p_payload->>'dose'),coalesce(p_payload->>'photo',''),p_actor) on conflict(id) do nothing;
    if not found and not exists(select 1 from public.medications where id=(p_payload->>'id')::uuid and created_by=p_actor and name=trim(p_payload->>'name') and timing=p_payload->>'timing' and dose=trim(p_payload->>'dose') and photo=coalesce(p_payload->>'photo','')) then raise exception 'conflicting retry' using errcode='22023'; end if;
  when 'medicine_remove' then
    delete from public.medications where id=(p_payload->>'id')::uuid;
  when 'appointment_save' then
    insert into public.appointment(id,date,department,instructions,updated_by) values(1,(p_payload->>'date')::date,trim(p_payload->>'department'),coalesce(p_payload->>'instructions',''),p_actor)
    on conflict(id) do update set date=excluded.date,department=excluded.department,instructions=excluded.instructions,updated_by=p_actor;
  when 'state' then null;
  else raise exception 'invalid action' using errcode='22023';
  end case;

  select jsonb_build_object(
    'records',coalesce((select jsonb_agg(jsonb_build_object('id',id,'measuredAt',measured_at,'systolic',systolic,'diastolic',diastolic,'pulse',pulse,'spo2',spo2,'temperature',temperature,'period',period,'note',note,'photo',photo) order by measured_at desc) from public.health_records),'[]'::jsonb),
    'checklists',coalesce((select jsonb_object_agg(day,items) from (select day::text, jsonb_object_agg(item,done) items from public.daily_checklists group by day) d),'{}'::jsonb),
    'logs',coalesce((select jsonb_agg(jsonb_build_object('id',id,'createdAt',created_at,'text',text,'photo',photo) order by created_at desc) from public.care_logs),'[]'::jsonb),
    'comments',coalesce((select jsonb_object_agg(target_id,items) from (select target_id::text,jsonb_agg(jsonb_build_object('id',id,'text',text,'createdAt',created_at) order by created_at) items from public.comments group by target_id) c),'{}'::jsonb),
    'reactions',coalesce((select jsonb_object_agg(target_id,items) from (select target_id::text,jsonb_object_agg(kind,true) items from public.reactions where line_user_id=p_actor group by target_id) r),'{}'::jsonb),
    'medicines',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'timing',timing,'dose',dose,'photo',photo) order by created_at) from public.medications),'[]'::jsonb),
    'appointment',(select jsonb_build_object('date',date,'department',department,'instructions',instructions) from public.appointment where id=1)
  ) into result;
  return result;
end $$;

revoke all on function public.care_api(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.care_api(text,text,jsonb) to service_role;

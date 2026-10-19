-- ════════════════════════════════════════════════════════════════════
-- Meow-PDF v0.11.5 · 공유작업 (프로젝트 공유 · 함께 편집 · 채팅 · 커서 · 공개 프로젝트 · 신고)
-- Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여 넣고 Run 하세요.
-- 먼저 supabase-social.sql 을 실행해 두어야 해요 (meow_me · meow_are_friends 를 써요).
-- 여러 번 실행해도 안전해요.
--
-- 구조
--  · share_projects : 공유 프로젝트 (고유 코드 · 이름 · 공개 범위 · 코드 입장 허용)
--  · share_members  : 참여자와 권한 (owner 방장 · editor 편집 허용 · viewer 관전자)
--  · share_bans     : 추방된 사람 (다시 들어올 수 없어요)
--  · share_chat     : 프로젝트 채팅
--  · 문서 파일은 Storage 버킷 meow-share 의 <프로젝트 id>/doc.mpdf 에 올려요.
--  · 실시간(편집 내용 · 커서 · 채팅 알림)은 Supabase Realtime 의 비공개 채널
--    'share:<프로젝트 id>' 를 써요. 참여자만 채널에 들어올 수 있게 아래 정책으로 막아요.
--  · 프로젝트를 만들고(방장) 공개 범위를 바꾸는 건 프리미엄, 참여는 로그인만 하면 돼요.
--    참여도 프리미엄으로 막으려면 share_join · share_join_code 의 meow_me(false) 를 meow_me() 로 바꾸세요.
--  · v0.11.4: 모두 공개 목록(검색 · 인원순/최신순) — 친구가 아닌 사람은 프리미엄만 들어올 수 있어요.
--    최대 10명(가득 차면 FULL) · 입장 비밀번호(선택) · 장르 · 입장 기본 권한 · 나간 사람은 참여자 목록에서 빠져요
--    (3분 넘게 신호가 없는 참여자도 정리). 방 · 채팅 신고(share_reports) → 개발자 계정의 ‘고객 문의 관리 › 신고’,
--    처리할 때 공유작업 이용 제한(1개월 · 3개월 · 1년 · 영구, share_restrictions).
--  · v1.0.3: 방 설명(description, 500자까지) — 프로젝트 관리에서 입력하고 방 정보 창에 보여요.
-- ════════════════════════════════════════════════════════════════════

-- 1) 표
create table if not exists public.share_projects (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  code         text not null unique,
  name         text not null default '공유 프로젝트' check (char_length(name) between 1 and 80),
  visibility   text not null default 'private' check (visibility in ('public', 'friends', 'private')),
  code_join    boolean not null default true,
  status       text not null default 'live' check (status in ('live', 'ended')),
  snap_ver     integer not null default 0,
  created_at   timestamptz not null default now(),
  last_active  timestamptz not null default now()
);
create index if not exists share_projects_owner_idx on public.share_projects (owner_id, last_active desc);
create index if not exists share_projects_vis_idx on public.share_projects (visibility, status, last_active desc);

create table if not exists public.share_members (
  project_id uuid not null references public.share_projects(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'viewer' check (role in ('owner', 'editor', 'viewer')),
  joined_at  timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists share_members_user_idx on public.share_members (user_id);

create table if not exists public.share_bans (
  project_id uuid not null references public.share_projects(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table if not exists public.share_chat (
  id         bigserial primary key,
  project_id uuid not null references public.share_projects(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  body       text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists share_chat_proj_idx on public.share_chat (project_id, id desc);

-- v0.11.4 장르 · 입장 비밀번호(bcrypt) · 입장 기본 권한
create extension if not exists pgcrypto with schema extensions;
alter table public.share_projects add column if not exists genre text not null default '';
alter table public.share_projects add column if not exists pw_hash text;
alter table public.share_projects add column if not exists default_role text not null default 'viewer';
-- v1.0.3 방 설명
alter table public.share_projects add column if not exists description text not null default '';
create index if not exists share_projects_new_idx on public.share_projects (visibility, status, created_at desc);

-- v0.11.4 신고 (방 · 채팅 · 사용자) — 신고 당시의 방 이름 · 방장 · 정보를 그대로 남겨요
create table if not exists public.share_reports (
  id           bigserial primary key,
  project_id   uuid references public.share_projects(id) on delete set null,
  project_name text,
  project_code text,
  owner_id     uuid,
  owner_name   text,
  reporter_id  uuid references auth.users(id) on delete set null,
  target_id    uuid,
  target_name  text,
  kind         text not null check (kind in ('room', 'chat', 'user')),
  reason       text not null check (reason in ('불건전', '욕설', '명예훼손', '범죄', '기타')),
  detail       text check (detail is null or char_length(detail) <= 1000),
  chat_body    text,
  info         jsonb not null default '{}'::jsonb,
  status       text not null default 'new' check (status in ('new', 'done', 'dismissed')),
  penalty      text,
  memo         text,
  created_at   timestamptz not null default now(),
  handled_at   timestamptz
);
alter table public.share_reports add column if not exists chat_log jsonb;   -- v0.11.5 신고할 때의 채팅 기록
create index if not exists share_reports_status_idx on public.share_reports (status, created_at desc);
create index if not exists share_reports_reporter_idx on public.share_reports (reporter_id, created_at desc);

-- v0.11.4 공유작업 이용 제한 (until 이 null 이면 영구)
create table if not exists public.share_restrictions (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  until      timestamptz,
  reason     text,
  report_id  bigint,
  created_at timestamptz not null default now()
);

-- 2) 행 보안: 표는 직접 읽고 쓸 수 없고, 아래 함수(rpc)로만 다뤄요
alter table public.share_projects enable row level security;
alter table public.share_members  enable row level security;
alter table public.share_bans     enable row level security;
alter table public.share_chat     enable row level security;
alter table public.share_reports  enable row level security;
alter table public.share_restrictions enable row level security;
revoke all on public.share_projects, public.share_members, public.share_bans, public.share_chat, public.share_reports, public.share_restrictions from anon, authenticated;

-- 3) 도우미 (정책에서도 써요)
create or replace function public.share_role(p_project uuid)
returns text language sql stable security definer set search_path = public as $$
  select m.role from public.share_members m join public.share_projects s on s.id = m.project_id
  where m.project_id = p_project and m.user_id = auth.uid() and s.status = 'live';
$$;
create or replace function public.share_is_member(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.share_role(p_project) is not null;
$$;
create or replace function public.share_can_edit(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.share_role(p_project) in ('owner', 'editor'), false);
$$;
-- 'share:<uuid>' · '<uuid>/doc.mpdf' 에서 uuid 를 안전하게 꺼내요 (형식이 틀리면 null)
create or replace function public.share_uuid(p text)
returns uuid language sql immutable as $$
  select case when p ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end;
$$;

create or replace function public.share_new_code()
returns text language plpgsql volatile set search_path = public as $$
declare c text; abc text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int;
begin
  loop
    c := '';
    for i in 1..6 loop c := c || substr(abc, 1 + floor(random() * length(abc))::int, 1); end loop;
    exit when not exists (select 1 from public.share_projects where code = c);
  end loop;
  return c;
end $$;

-- v0.11.4 도우미: 최대 인원 · 장르 · 개발자 · 이용 제한 · 오래된 참여자 정리 · 비밀번호 확인
create or replace function public.share_max() returns int language sql immutable as $$ select 10 $$;
create or replace function public.share_genres() returns text[] language sql immutable as $$ select array['', '교육', '개발', '그림', '디자인', '공부', '업무', '기타'] $$;
create or replace function public.meow_is_dev()
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null and lower(u.email) = 'architect05092@gmail.com');
$$;
-- 이용 제한 중이면 'RESTRICTED:YYYY-MM-DD'(영구는 'RESTRICTED:PERM') 오류
create or replace function public.share_check_restrict(p_uid uuid)
returns void language plpgsql stable security definer set search_path = public as $$
declare r record;
begin
  select * into r from public.share_restrictions where user_id = p_uid and (until is null or until > now());
  if r.user_id is not null then raise exception 'RESTRICTED:%', coalesce(to_char(r.until at time zone 'Asia/Seoul', 'YYYY-MM-DD'), 'PERM'); end if;
end $$;
-- 3분 넘게 신호(ping)가 없는 참여자(방장 제외)는 나간 것으로 봐요
create or replace function public.share_cleanup(p_project uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.share_members where project_id = p_project and role <> 'owner' and last_seen < now() - interval '3 minutes';
$$;
create or replace function public.share_count(p_project uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.share_members where project_id = p_project and (role = 'owner' or last_seen > now() - interval '3 minutes');
$$;
create or replace function public.share_pw_ok(p_hash text, p_pw text)
returns boolean language sql stable set search_path = public, extensions as $$
  select p_hash is null or (p_pw is not null and crypt(p_pw, p_hash) = p_hash);
$$;
-- 처음 들어오는 사람 확인: 비밀번호 → 인원 → 참여자로 넣기
create or replace function public.share_admit(p_project uuid, p_me uuid, p_pw text)
returns void language plpgsql security definer set search_path = public as $$
declare s record;
begin
  select * into s from public.share_projects where id = p_project;
  if s.pw_hash is not null then
    if coalesce(p_pw, '') = '' then raise exception 'PASSWORD_REQUIRED'; end if;
    if not public.share_pw_ok(s.pw_hash, p_pw) then raise exception 'BAD_PASSWORD'; end if;
  end if;
  perform public.share_cleanup(p_project);
  if public.share_count(p_project) >= public.share_max() then raise exception 'FULL'; end if;
  insert into public.share_members (project_id, user_id, role)
    values (p_project, p_me, case when s.default_role in ('editor', 'viewer') then s.default_role else 'viewer' end)
    on conflict (project_id, user_id) do update set last_seen = now();
end $$;

-- 프로젝트 + 참여자 목록 (프로필 포함)
create or replace function public.share_info(p_project uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', s.id, 'code', s.code, 'name', s.name, 'visibility', s.visibility, 'code_join', s.code_join,
    'status', s.status, 'snap_ver', s.snap_ver, 'owner_id', s.owner_id,
    'genre', s.genre, 'has_password', s.pw_hash is not null, 'default_role', s.default_role, 'max', public.share_max(),
    'description', coalesce(s.description, ''),
    'my_role', (select role from public.share_members where project_id = s.id and user_id = auth.uid()),
    'members', coalesce((select json_agg(json_build_object(
        'user_id', m.user_id, 'role', m.role, 'username', p.username, 'nickname', p.nickname, 'avatar_url', p.avatar_url,
        'last_seen', m.last_seen) order by (m.role = 'owner') desc, m.joined_at)
      from public.share_members m left join public.users_profile p on p.id = m.user_id
      where m.project_id = s.id and (m.role = 'owner' or m.user_id = auth.uid() or m.last_seen > now() - interval '3 minutes')), '[]'::json))
  from public.share_projects s where s.id = p_project;
$$;

-- 4) 앱에서 부르는 함수 (rpc)
-- v0.11.4 매개변수 · 반환 형식이 바뀐 함수는 예전 것을 먼저 지워요
drop function if exists public.share_update(uuid, text, text, boolean);
drop function if exists public.share_join(uuid);
drop function if exists public.share_join_code(text);
drop function if exists public.share_ping(uuid);
drop function if exists public.share_friend_projects();
drop function if exists public.share_update(uuid, text, text, boolean, text, text, text, boolean);   -- v1.0.3 p_description 추가

-- 새 프로젝트 (방장 · 프리미엄)
create or replace function public.share_create(p_name text default null)
returns json language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(); pid uuid;
begin
  perform public.share_check_restrict(me);
  if (select count(*) from public.share_projects where owner_id = me and status = 'live') >= 20 then raise exception 'TOO_MANY'; end if;
  insert into public.share_projects (owner_id, code, name)
    values (me, public.share_new_code(), left(coalesce(nullif(trim(p_name), ''), '공유 프로젝트'), 80))
    returning id into pid;
  insert into public.share_members (project_id, user_id, role) values (pid, me, 'owner');
  return public.share_info(pid);
end $$;

-- 프로젝트 정보 (참여자만)
create or replace function public.share_get(p_project uuid)
returns json language plpgsql stable security definer set search_path = public as $$
declare me uuid := public.meow_me(false);
begin
  if not exists (select 1 from public.share_members where project_id = p_project and user_id = me) then raise exception 'NOT_MEMBER'; end if;
  return public.share_info(p_project);
end $$;

-- 이름 · 공개 범위 · 코드 입장 허용 · 장르 · 입장 기본 권한 · 비밀번호 · 방 설명 바꾸기 (방장 · 프리미엄, null 이면 그대로)
--   p_password: 새 비밀번호(4~32자) · p_password_off = true: 비밀번호 끄기 · p_description: 방 설명(500자까지, '' 이면 지우기)
create or replace function public.share_update(p_project uuid, p_name text default null, p_visibility text default null, p_code_join boolean default null,
  p_genre text default null, p_default_role text default null, p_password text default null, p_password_off boolean default null, p_description text default null)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare me uuid := public.meow_me();
begin
  perform public.share_check_restrict(me);
  if p_password is not null and char_length(p_password) not between 4 and 32 then raise exception 'BAD_PW_LEN'; end if;
  update public.share_projects set
    name = coalesce(left(nullif(trim(p_name), ''), 80), name),
    visibility = case when p_visibility in ('public', 'friends', 'private') then p_visibility else visibility end,
    code_join = coalesce(p_code_join, code_join),
    genre = case when p_genre is not null and p_genre = any(public.share_genres()) then p_genre else genre end,
    default_role = case when p_default_role in ('editor', 'viewer') then p_default_role else default_role end,
    pw_hash = case when p_password_off then null when p_password is not null then crypt(p_password, gen_salt('bf', 8)) else pw_hash end,
    description = case when p_description is null then description else left(trim(p_description), 500) end
  where id = p_project and owner_id = me and status = 'live';
  if not found then raise exception 'NOT_OWNER'; end if;
  return public.share_info(p_project);
end $$;

-- 참여자 권한 (방장만): 'editor' 편집 허용 · 'viewer' 관전자
create or replace function public.share_set_role(p_project uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false);
begin
  if p_role not in ('editor', 'viewer') then raise exception 'BAD_ROLE'; end if;
  if not exists (select 1 from public.share_projects where id = p_project and owner_id = me) then raise exception 'NOT_OWNER'; end if;
  update public.share_members set role = p_role where project_id = p_project and user_id = p_user and role <> 'owner';
end $$;

-- 추방 (방장만): 참여자에서 빼고 다시 못 들어오게
create or replace function public.share_kick(p_project uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false);
begin
  if not exists (select 1 from public.share_projects where id = p_project and owner_id = me) then raise exception 'NOT_OWNER'; end if;
  if p_user = me then raise exception 'SELF'; end if;
  delete from public.share_members where project_id = p_project and user_id = p_user;
  insert into public.share_bans (project_id, user_id) values (p_project, p_user) on conflict do nothing;
end $$;

-- 공유 종료 (방장만)
create or replace function public.share_end(p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false);
begin
  update public.share_projects set status = 'ended' where id = p_project and owner_id = me;
  if not found then raise exception 'NOT_OWNER'; end if;
end $$;

-- 참여 (친구 프로젝트 · 공개 프로젝트 · 내 프로젝트 다시 열기)
--   모두 공개는 방장의 친구이거나 프리미엄이면 들어올 수 있어요. 처음 들어올 때만 비밀번호 · 인원(최대 10명)을 확인해요.
create or replace function public.share_join(p_project uuid, p_password text default null)
returns json language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false); s record;
begin
  perform public.share_check_restrict(me);
  select * into s from public.share_projects where id = p_project;
  if s.id is null or s.status <> 'live' then raise exception 'PROJECT_GONE'; end if;
  if exists (select 1 from public.share_bans where project_id = s.id and user_id = me) then raise exception 'BANNED'; end if;
  if not exists (select 1 from public.share_members where project_id = s.id and user_id = me) then
    if s.visibility = 'private' or (s.visibility = 'friends' and not public.meow_are_friends(me, s.owner_id)) then raise exception 'NO_ACCESS'; end if;
    if s.visibility = 'public' and not public.meow_are_friends(me, s.owner_id) and not public.meow_is_premium(me) then raise exception 'PREMIUM_JOIN'; end if;
    perform public.share_admit(s.id, me, p_password);
  else
    update public.share_members set last_seen = now() where project_id = s.id and user_id = me;
  end if;
  return public.share_info(s.id);
end $$;

-- 고유 코드로 참여 (친구가 아니어도, 방장이 '코드로 입장'을 허용했을 때)
create or replace function public.share_join_code(p_code text, p_password text default null)
returns json language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false); s record;
begin
  perform public.share_check_restrict(me);
  select * into s from public.share_projects where code = upper(trim(p_code));
  if s.id is null or s.status <> 'live' then raise exception 'CODE_NOT_FOUND'; end if;
  if exists (select 1 from public.share_bans where project_id = s.id and user_id = me) then raise exception 'BANNED'; end if;
  if not exists (select 1 from public.share_members where project_id = s.id and user_id = me) then
    if not s.code_join then raise exception 'CODE_OFF'; end if;
    perform public.share_admit(s.id, me, p_password);
  else
    update public.share_members set last_seen = now() where project_id = s.id and user_id = me;
  end if;
  return public.share_info(s.id);
end $$;

-- 나가기 (방장은 나갈 수 없고 '공유 종료'를 써요)
create or replace function public.share_leave(p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false);
begin
  delete from public.share_members where project_id = p_project and user_id = me and role <> 'owner';
end $$;

-- 접속 중 신호 (1분마다). 아직 참여자이면 true — 방장의 신호 때 오래된 참여자를 정리해요
create or replace function public.share_ping(p_project uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false); r text;
begin
  update public.share_members set last_seen = now() where project_id = p_project and user_id = me returning role into r;
  if r is null then return false; end if;
  update public.share_projects set last_active = now() where id = p_project and status = 'live';
  if r = 'owner' then perform public.share_cleanup(p_project); end if;
  return true;
end $$;

-- 문서 파일을 새로 올렸을 때 버전 올리기 (편집 권한)
create or replace function public.share_bump_snap(p_project uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  perform public.meow_me(false);
  if not public.share_can_edit(p_project) then raise exception 'NO_EDIT'; end if;
  update public.share_projects set snap_ver = snap_ver + 1, last_active = now() where id = p_project returning snap_ver into v;
  return v;
end $$;

-- 친구 프로젝트: 친구가 '친구 공개' · '모두 공개'로 진행 중인(3분 안에 접속이 있었던) 프로젝트
--   (앱은 친구 프로젝트 목록에 '친구 공개'만, 친구 창의 '함께 작업' 버튼에는 둘 다 써요)
create or replace function public.share_friend_projects()
returns table (id uuid, name text, owner_id uuid, username text, nickname text, avatar_url text, members int, last_active timestamptz, joined boolean,
  visibility text, genre text, has_password boolean, max_members int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare me uuid := public.meow_me(false);
begin
  return query
    select s.id, s.name, s.owner_id, p.username::text, p.nickname::text, p.avatar_url::text,
      public.share_count(s.id),
      s.last_active, exists (select 1 from public.share_members m where m.project_id = s.id and m.user_id = me),
      s.visibility, s.genre, s.pw_hash is not null, public.share_max()
    from public.share_projects s left join public.users_profile p on p.id = s.owner_id
    where s.status = 'live' and s.visibility in ('friends', 'public') and s.owner_id <> me
      and s.last_active > now() - interval '3 minutes'
      and public.meow_are_friends(me, s.owner_id)
      and not exists (select 1 from public.share_bans b where b.project_id = s.id and b.user_id = me)
    order by s.last_active desc;
end $$;

-- 내가 만든 · 참여한 진행 중 프로젝트 (다시 열기)
create or replace function public.share_my_projects()
returns table (id uuid, name text, code text, role text, owner_id uuid, username text, nickname text, avatar_url text, last_active timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare me uuid := public.meow_me(false);
begin
  return query
    select s.id, s.name, s.code, m.role, s.owner_id, p.username::text, p.nickname::text, p.avatar_url::text, s.last_active
    from public.share_members m join public.share_projects s on s.id = m.project_id
    left join public.users_profile p on p.id = s.owner_id
    where m.user_id = me and s.status = 'live'
    order by s.last_active desc limit 30;
end $$;

-- 채팅
create or replace function public.share_chat_send(p_project uuid, p_body text)
returns json language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false); r public.share_chat;
begin
  perform public.share_check_restrict(me);
  if not public.share_is_member(p_project) then raise exception 'NOT_MEMBER'; end if;
  if char_length(trim(coalesce(p_body, ''))) = 0 then raise exception 'EMPTY'; end if;
  insert into public.share_chat (project_id, user_id, body) values (p_project, me, left(trim(p_body), 500)) returning * into r;
  return json_build_object('id', r.id, 'user_id', r.user_id, 'body', r.body, 'created_at', r.created_at);
end $$;

create or replace function public.share_chat_list(p_project uuid, p_limit int default 80)
returns table (id bigint, user_id uuid, username text, nickname text, avatar_url text, body text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.meow_me(false);
  if not public.share_is_member(p_project) then raise exception 'NOT_MEMBER'; end if;
  return query
    select * from (
      select c.id, c.user_id, p.username::text, p.nickname::text, p.avatar_url::text, c.body, c.created_at
      from public.share_chat c left join public.users_profile p on p.id = c.user_id
      where c.project_id = p_project order by c.id desc limit least(greatest(coalesce(p_limit, 80), 1), 200)
    ) t order by t.id;
end $$;

-- ── v0.11.4 공개 프로젝트 · 방 미리보기 · 신고 ──

-- 공개 프로젝트 목록: 검색(이름 · 장르 · 방장) · 정렬('members' 인원순 · 'new' 최신순)
create or replace function public.share_public_projects(p_q text default null, p_sort text default 'members')
returns table (id uuid, name text, genre text, owner_id uuid, username text, nickname text, avatar_url text, members int, max_members int,
  has_password boolean, created_at timestamptz, last_active timestamptz, joined boolean, friend boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare me uuid := public.meow_me(false); q text := nullif(trim(coalesce(p_q, '')), '');
begin
  return query
    select * from (
      select s.id, s.name, s.genre, s.owner_id, p.username::text, p.nickname::text, p.avatar_url::text,
        public.share_count(s.id) as members, public.share_max(), s.pw_hash is not null, s.created_at, s.last_active,
        exists (select 1 from public.share_members m where m.project_id = s.id and m.user_id = me),
        public.meow_are_friends(me, s.owner_id)
      from public.share_projects s left join public.users_profile p on p.id = s.owner_id
      where s.status = 'live' and s.visibility = 'public' and s.last_active > now() - interval '3 minutes'
        and not exists (select 1 from public.share_bans b where b.project_id = s.id and b.user_id = me)
        and (q is null or s.name ilike '%' || q || '%' or s.genre = q or p.nickname ilike '%' || q || '%' or p.username ilike '%' || q || '%')
    ) t
    order by case when p_sort = 'new' then null else t.members end desc nulls last, t.created_at desc
    limit 100;
end $$;

-- 방 미리보기 (함께 작업 · 보기 버튼): 간단한 정보와 지금 참여 중인 사람
create or replace function public.share_preview(p_project uuid)
returns json language plpgsql stable security definer set search_path = public as $$
declare me uuid := public.meow_me(false); s record; mem boolean; fr boolean;
begin
  select * into s from public.share_projects where id = p_project;
  if s.id is null or s.status <> 'live' then raise exception 'PROJECT_GONE'; end if;
  if exists (select 1 from public.share_bans where project_id = s.id and user_id = me) then raise exception 'BANNED'; end if;
  mem := exists (select 1 from public.share_members where project_id = s.id and user_id = me);
  fr := public.meow_are_friends(me, s.owner_id);
  if not mem and (s.visibility = 'private' or (s.visibility = 'friends' and not fr)) then raise exception 'NO_ACCESS'; end if;
  return (select json_build_object(
    'id', s.id, 'name', s.name, 'genre', s.genre, 'visibility', s.visibility, 'owner_id', s.owner_id, 'description', coalesce(s.description, ''),
    'owner', (select json_build_object('user_id', p.id, 'username', p.username, 'nickname', p.nickname, 'avatar_url', p.avatar_url) from public.users_profile p where p.id = s.owner_id),
    'created_at', s.created_at, 'last_active', s.last_active, 'has_password', s.pw_hash is not null, 'default_role', s.default_role,
    'count', public.share_count(s.id), 'max', public.share_max(), 'joined', mem, 'friend', fr,
    'need_premium', s.visibility = 'public' and not fr and not mem and not public.meow_is_premium(me),
    'members', coalesce((select json_agg(json_build_object('user_id', m.user_id, 'role', m.role, 'username', p.username, 'nickname', p.nickname, 'avatar_url', p.avatar_url)
        order by (m.role = 'owner') desc, m.joined_at)
      from public.share_members m left join public.users_profile p on p.id = m.user_id
      where m.project_id = s.id and (m.role = 'owner' or m.last_seen > now() - interval '3 minutes')), '[]'::json)));
end $$;

-- 신고: p_kind 'room' 방(→ 방장) · 'chat' 채팅 한 줄(→ 쓴 사람) · 'user' 참여자
create or replace function public.share_report(p_project uuid, p_kind text, p_reason text, p_detail text default null, p_target uuid default null, p_chat_id bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false); s record; tgt uuid; body text; tname text; oname text; log jsonb;
begin
  if p_kind not in ('room', 'chat', 'user') then raise exception 'BAD_KIND'; end if;
  if p_reason not in ('불건전', '욕설', '명예훼손', '범죄', '기타') then raise exception 'BAD_REASON'; end if;
  if (select count(*) from public.share_reports where reporter_id = me and created_at > now() - interval '10 minutes') >= 5 then raise exception 'TOO_MANY_REPORTS'; end if;
  select * into s from public.share_projects where id = p_project;
  if s.id is null then raise exception 'PROJECT_GONE'; end if;
  if p_kind = 'room' then tgt := s.owner_id;
  elsif p_kind = 'chat' then
    select c.user_id, c.body into tgt, body from public.share_chat c where c.id = p_chat_id and c.project_id = s.id;
    if tgt is null then raise exception 'NOT_FOUND'; end if;
  else tgt := p_target;
  end if;
  if tgt is null then raise exception 'NOT_FOUND'; end if;
  if tgt = me then raise exception 'SELF'; end if;
  if exists (select 1 from public.share_reports where reporter_id = me and project_id = s.id and target_id = tgt and kind = p_kind and status = 'new'
      and (p_chat_id is null or chat_body is not distinct from body)) then raise exception 'ALREADY_REPORTED'; end if;
  -- v0.11.5 채팅 기록도 함께 남겨요: 채팅 신고는 그 메시지 앞 20개 · 뒤 10개, 그 밖에는 최근 30개
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'u', c.user_id, 'n', coalesce(nullif(p.nickname, ''), p.username, '알 수 없음'),
      'un', p.username, 'b', c.body, 't', c.created_at) order by c.id), '[]'::jsonb) into log
  from (
    (select * from public.share_chat x where x.project_id = s.id and (p_kind <> 'chat' or x.id <= p_chat_id) order by x.id desc limit case when p_kind = 'chat' then 21 else 30 end)
    union all
    (select * from public.share_chat x where p_kind = 'chat' and x.project_id = s.id and x.id > p_chat_id order by x.id limit 10)
  ) c left join public.users_profile p on p.id = c.user_id;
  select coalesce(nickname, username) || coalesce(' (@' || username || ')', '') into oname from public.users_profile where id = s.owner_id;
  select coalesce(nickname, username) || coalesce(' (@' || username || ')', '') into tname from public.users_profile where id = tgt;
  insert into public.share_reports (project_id, project_name, project_code, owner_id, owner_name, reporter_id, target_id, target_name, kind, reason, detail, chat_body, chat_log, info)
  values (s.id, s.name, s.code, s.owner_id, oname, me, tgt, tname, p_kind, p_reason, left(nullif(trim(coalesce(p_detail, '')), ''), 1000), body, log,
    jsonb_build_object('visibility', s.visibility, 'genre', s.genre, 'status', s.status, 'members', public.share_count(s.id),
      'has_password', s.pw_hash is not null, 'created_at', s.created_at, 'last_active', s.last_active));
end $$;

-- 내 공유작업 이용 제한 (없으면 null)
create or replace function public.share_my_restriction()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('until', until, 'reason', reason) from public.share_restrictions
  where user_id = auth.uid() and (until is null or until > now());
$$;

-- 개발자: 신고 목록 (p_status: 'new' · 'done' · 'dismissed' · null 전체)
create or replace function public.share_report_list(p_status text default null)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.meow_is_dev() then raise exception 'NOT_DEV'; end if;
  return json_build_object(
    'counts', (select json_build_object('new', count(*) filter (where status = 'new'), 'done', count(*) filter (where status = 'done'), 'dismissed', count(*) filter (where status = 'dismissed')) from public.share_reports),
    'items', coalesce((select json_agg(x order by x.created_at desc) from (
      select r.*, coalesce(rp.nickname, rp.username) || coalesce(' (@' || rp.username || ')', '') as reporter_name,
        (select json_build_object('until', z.until) from public.share_restrictions z where z.user_id = r.target_id and (z.until is null or z.until > now())) as restricted
      from public.share_reports r left join public.users_profile rp on rp.id = r.reporter_id
      where p_status is null or r.status = p_status
      order by r.created_at desc limit 200) x), '[]'::json));
end $$;

-- 개발자: 신고 처리 — p_status 'done' 처리 · 'dismissed' 기각 · 'new' 되돌리기,
--   p_penalty '1m' · '3m' · '1y' · 'perm' 이면 신고 대상(방 신고는 방장)의 공유작업 이용을 제한하고 진행 중인 방을 닫아요
create or replace function public.share_report_handle(p_id bigint, p_status text, p_penalty text default null, p_memo text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r record; u timestamptz;
begin
  if not public.meow_is_dev() then raise exception 'NOT_DEV'; end if;
  if p_status not in ('new', 'done', 'dismissed') then raise exception 'BAD_STATUS'; end if;
  if p_penalty is not null and p_penalty not in ('1m', '3m', '1y', 'perm') then raise exception 'BAD_PENALTY'; end if;
  select * into r from public.share_reports where id = p_id;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  if p_penalty is not null and r.target_id is not null then
    u := case p_penalty when '1m' then now() + interval '1 month' when '3m' then now() + interval '3 months' when '1y' then now() + interval '1 year' else null end;
    insert into public.share_restrictions (user_id, until, reason, report_id) values (r.target_id, u, r.reason, r.id)
      on conflict (user_id) do update set until = case when public.share_restrictions.until is null or excluded.until is null then null
        else greatest(public.share_restrictions.until, excluded.until) end, reason = excluded.reason, report_id = excluded.report_id, created_at = now();
    update public.share_projects set status = 'ended' where owner_id = r.target_id and status = 'live';
  end if;
  update public.share_reports set status = p_status, penalty = coalesce(p_penalty, penalty), memo = coalesce(p_memo, memo),
    handled_at = case when p_status = 'new' then null else now() end where id = p_id;
end $$;

-- 개발자: 이용 제한 풀기 · 신고 삭제
create or replace function public.share_restrict_lift(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.meow_is_dev() then raise exception 'NOT_DEV'; end if;
  delete from public.share_restrictions where user_id = p_user;
end $$;
create or replace function public.share_report_delete(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.meow_is_dev() then raise exception 'NOT_DEV'; end if;
  delete from public.share_reports where id = p_id;
end $$;

-- 5) 실행 권한
revoke execute on function public.share_new_code(), public.share_info(uuid) from public, anon, authenticated;
revoke execute on function public.share_max(), public.share_genres(), public.meow_is_dev(), public.share_check_restrict(uuid), public.share_cleanup(uuid),
  public.share_count(uuid), public.share_pw_ok(text, text), public.share_admit(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.share_role(uuid), public.share_is_member(uuid), public.share_can_edit(uuid), public.share_uuid(text) from public, anon;
grant  execute on function public.share_role(uuid), public.share_is_member(uuid), public.share_can_edit(uuid), public.share_uuid(text) to authenticated;
revoke execute on function public.share_create(text), public.share_get(uuid), public.share_update(uuid, text, text, boolean, text, text, text, boolean, text), public.share_set_role(uuid, uuid, text),
  public.share_kick(uuid, uuid), public.share_end(uuid), public.share_join(uuid, text), public.share_join_code(text, text), public.share_leave(uuid), public.share_ping(uuid),
  public.share_bump_snap(uuid), public.share_friend_projects(), public.share_my_projects(), public.share_chat_send(uuid, text), public.share_chat_list(uuid, int),
  public.share_public_projects(text, text), public.share_preview(uuid), public.share_report(uuid, text, text, text, uuid, bigint), public.share_my_restriction(),
  public.share_report_list(text), public.share_report_handle(bigint, text, text, text), public.share_restrict_lift(uuid), public.share_report_delete(bigint) from public, anon;
grant execute on function public.share_create(text), public.share_get(uuid), public.share_update(uuid, text, text, boolean, text, text, text, boolean, text), public.share_set_role(uuid, uuid, text),
  public.share_kick(uuid, uuid), public.share_end(uuid), public.share_join(uuid, text), public.share_join_code(text, text), public.share_leave(uuid), public.share_ping(uuid),
  public.share_bump_snap(uuid), public.share_friend_projects(), public.share_my_projects(), public.share_chat_send(uuid, text), public.share_chat_list(uuid, int),
  public.share_public_projects(text, text), public.share_preview(uuid), public.share_report(uuid, text, text, text, uuid, bigint), public.share_my_restriction(),
  public.share_report_list(text), public.share_report_handle(bigint, text, text, text), public.share_restrict_lift(uuid), public.share_report_delete(bigint) to authenticated;

-- 6) Storage: 문서 파일 버킷 (비공개, 50MB)
insert into storage.buckets (id, name, public, file_size_limit)
values ('meow-share', 'meow-share', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "meow share read" on storage.objects;
create policy "meow share read" on storage.objects for select to authenticated
  using (bucket_id = 'meow-share' and public.share_is_member(public.share_uuid((storage.foldername(name))[1])));
drop policy if exists "meow share insert" on storage.objects;
create policy "meow share insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'meow-share' and public.share_can_edit(public.share_uuid((storage.foldername(name))[1])));
drop policy if exists "meow share update" on storage.objects;
create policy "meow share update" on storage.objects for update to authenticated
  using (bucket_id = 'meow-share' and public.share_can_edit(public.share_uuid((storage.foldername(name))[1])))
  with check (bucket_id = 'meow-share' and public.share_can_edit(public.share_uuid((storage.foldername(name))[1])));

-- 7) Realtime: 'share:<프로젝트 id>' 비공개 채널은 참여자만 듣고(select) 보낼(insert) 수 있어요
drop policy if exists "meow share realtime read" on realtime.messages;
create policy "meow share realtime read" on realtime.messages for select to authenticated
  using (realtime.topic() like 'share:%' and public.share_is_member(public.share_uuid(split_part(realtime.topic(), ':', 2))));
drop policy if exists "meow share realtime write" on realtime.messages;
create policy "meow share realtime write" on realtime.messages for insert to authenticated
  with check (realtime.topic() like 'share:%' and public.share_is_member(public.share_uuid(split_part(realtime.topic(), ':', 2))));

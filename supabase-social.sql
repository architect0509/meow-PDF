-- ════════════════════════════════════════════════════════════════════
-- Meow-PDF v0.10.1 · 친구 · 메일 · 알림 (프리미엄 기능)
-- Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여 넣고 Run 하세요.
-- 여러 번 실행해도 안전해요(이미 있는 표 · 칸은 그대로 두고 함수만 새로 만들어요).
--
-- 구조
--  · 표는 모두 RLS(행 보안)로 잠그고, "읽기"만 본인 것에 허용해요.
--  · 쓰기(친구 요청 · 수락 · 메일 보내기 · 알림 읽음 등)는 아래 함수(rpc)로만 할 수 있어요.
--    함수 안에서 로그인한 사람(auth.uid())과 프리미엄 여부를 서버가 직접 확인해요.
--  · 프리미엄 판별은 편집기와 같아요: 학교 이메일(.ac.kr/.edu) 인증 · 결제(is_paid) ·
--    이용 기간(premium_until) · 개발자 이메일.
-- ════════════════════════════════════════════════════════════════════

-- 1) 내 설정 칸: 친구 요청 받기 · 알림 종류별 켜기/끄기
alter table public.users_profile add column if not exists allow_friend_requests boolean not null default true;
alter table public.users_profile add column if not exists notif_prefs jsonb not null default '{"friend_request": true, "friend_accept": true, "mail": true}'::jsonb;

-- 2) 표
create table if not exists public.friend_requests (
  id         uuid primary key default gen_random_uuid(),
  from_id    uuid not null references auth.users(id) on delete cascade,
  to_id      uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint friend_requests_not_self check (from_id <> to_id),
  constraint friend_requests_once unique (from_id, to_id)
);
create index if not exists friend_requests_to_idx on public.friend_requests (to_id, created_at desc);

create table if not exists public.friendships (
  user_a     uuid not null references auth.users(id) on delete cascade,
  user_b     uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint friendships_order check (user_a < user_b)      -- 한 쌍은 한 줄만 (작은 id가 user_a)
);
create index if not exists friendships_b_idx on public.friendships (user_b);

create table if not exists public.mails (
  id               uuid primary key default gen_random_uuid(),
  from_id          uuid references auth.users(id) on delete set null,   -- 보낸 사람이 탈퇴해도 받은 메일은 남아요
  to_id            uuid not null references auth.users(id) on delete cascade,
  subject          text not null check (char_length(subject) between 1 and 100),
  body             text not null check (char_length(body) between 1 and 5000),
  created_at       timestamptz not null default now(),
  read_at          timestamptz,
  del_by_sender    boolean not null default false,
  del_by_recipient boolean not null default false
);
create index if not exists mails_to_idx   on public.mails (to_id, created_at desc);
create index if not exists mails_from_idx on public.mails (from_id, created_at desc);

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('friend_request', 'friend_accept', 'mail')),
  actor_id   uuid references auth.users(id) on delete cascade,
  ref_id     uuid,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- 3) 행 보안: 본인 것만 읽기, 직접 쓰기는 막음 (쓰기는 함수로만)
alter table public.friend_requests enable row level security;
alter table public.friendships     enable row level security;
alter table public.mails           enable row level security;
alter table public.notifications   enable row level security;

drop policy if exists "read own requests" on public.friend_requests;
create policy "read own requests" on public.friend_requests for select to authenticated using (auth.uid() in (from_id, to_id));
drop policy if exists "read own friendships" on public.friendships;
create policy "read own friendships" on public.friendships for select to authenticated using (auth.uid() in (user_a, user_b));
drop policy if exists "read own mails" on public.mails;
create policy "read own mails" on public.mails for select to authenticated
  using ((from_id = auth.uid() and not del_by_sender) or (to_id = auth.uid() and not del_by_recipient));
drop policy if exists "read own notifications" on public.notifications;
create policy "read own notifications" on public.notifications for select to authenticated using (user_id = auth.uid());

revoke insert, update, delete on public.friend_requests, public.friendships, public.mails, public.notifications from anon, authenticated;

-- 4) 내부 도우미 (직접 호출 불가)
create or replace function public.meow_is_premium(p_uid uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select coalesce((
    select (u.email_confirmed_at is not null and (
              lower(u.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.(ac\.kr|edu)$'
              or lower(u.email) = 'architect05092@gmail.com'))
        or coalesce((to_jsonb(p) ->> 'is_paid')::boolean, false)
        or coalesce((to_jsonb(p) ->> 'premium_until')::timestamptz > now(), false)
    from auth.users u left join public.users_profile p on p.id = u.id
    where u.id = p_uid), false);
$$;

create or replace function public.meow_me(p_premium boolean default true)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'LOGIN_REQUIRED'; end if;
  if p_premium and not public.meow_is_premium(me) then raise exception 'PREMIUM_REQUIRED'; end if;
  return me;
end $$;

create or replace function public.meow_are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.friendships where user_a = least(a, b) and user_b = greatest(a, b));
$$;

create or replace function public.meow_notify(p_user uuid, p_kind text, p_actor uuid, p_ref uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- 받는 사람이 그 종류의 알림을 꺼 두었으면 만들지 않아요
  if coalesce((select (notif_prefs ->> p_kind)::boolean from public.users_profile where id = p_user), true) then
    insert into public.notifications (user_id, kind, actor_id, ref_id) values (p_user, p_kind, p_actor, p_ref);
  end if;
end $$;

-- 5) 앱에서 부르는 함수 (rpc)

-- 내 상태: 프리미엄 · 설정 · 안 읽은 개수
create or replace function public.social_me()
returns json language plpgsql stable security definer set search_path = public as $$
declare me uuid := public.meow_me(false); p record;
begin
  select allow_friend_requests, notif_prefs into p from public.users_profile where id = me;
  return json_build_object(
    'premium', public.meow_is_premium(me),
    'allow_friend_requests', coalesce(p.allow_friend_requests, true),
    'notif_prefs', coalesce(p.notif_prefs, '{"friend_request": true, "friend_accept": true, "mail": true}'::jsonb),
    'unread_notifs', (select count(*) from public.notifications where user_id = me and read_at is null),
    'pending_in', (select count(*) from public.friend_requests where to_id = me),
    'unread_mail', (select count(*) from public.mails where to_id = me and read_at is null and not del_by_recipient));
end $$;

-- 설정 바꾸기 (null 이면 그대로)
create or replace function public.social_settings(p_allow boolean default null, p_prefs jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false);
begin
  update public.users_profile set
    allow_friend_requests = coalesce(p_allow, allow_friend_requests),
    notif_prefs = case when p_prefs is null then notif_prefs else notif_prefs || (
      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(p_prefs) as e(k, v)
      where k in ('friend_request', 'friend_accept', 'mail') and jsonb_typeof(v) = 'boolean') end
  where id = me;
end $$;

-- 아이디로 친구 요청 → 'sent' | 'already' | 'accepted'(상대가 먼저 보낸 요청이 있으면 바로 친구)
create or replace function public.friend_request(p_username text)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(); t record; rq uuid;
begin
  select id, allow_friend_requests into t from public.users_profile where lower(username) = lower(trim(p_username)) limit 1;
  if t.id is null then raise exception 'USER_NOT_FOUND'; end if;
  if t.id = me then raise exception 'SELF'; end if;
  if public.meow_are_friends(me, t.id) then raise exception 'ALREADY_FRIENDS'; end if;
  select id into rq from public.friend_requests where from_id = t.id and to_id = me;
  if rq is not null then
    delete from public.friend_requests where id = rq;
    insert into public.friendships (user_a, user_b) values (least(me, t.id), greatest(me, t.id)) on conflict do nothing;
    perform public.meow_notify(t.id, 'friend_accept', me, null);
    return 'accepted';
  end if;
  if not coalesce(t.allow_friend_requests, true) then raise exception 'REQUESTS_OFF'; end if;
  insert into public.friend_requests (from_id, to_id) values (me, t.id) on conflict do nothing returning id into rq;
  if rq is null then return 'already'; end if;
  perform public.meow_notify(t.id, 'friend_request', me, rq);
  return 'sent';
end $$;

-- 받은 요청 수락 / 거절
create or replace function public.friend_respond(p_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(p_accept); r record;
begin
  delete from public.friend_requests where id = p_id and to_id = me returning * into r;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  if p_accept then
    insert into public.friendships (user_a, user_b) values (least(me, r.from_id), greatest(me, r.from_id)) on conflict do nothing;
    perform public.meow_notify(r.from_id, 'friend_accept', me, null);
  end if;
  delete from public.notifications where user_id = me and kind = 'friend_request' and ref_id = p_id;
end $$;

-- 보낸 요청 취소
create or replace function public.friend_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false); r record;
begin
  delete from public.friend_requests where id = p_id and from_id = me returning * into r;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  delete from public.notifications where user_id = r.to_id and kind = 'friend_request' and ref_id = p_id;
end $$;

-- 친구 삭제
create or replace function public.friend_remove(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false);
begin
  delete from public.friendships where user_a = least(me, p_user) and user_b = greatest(me, p_user);
end $$;

-- 내 친구 목록
create or replace function public.friend_list()
returns table (user_id uuid, username text, nickname text, avatar_url text, since timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare me uuid := public.meow_me(false);
begin
  return query
    select o.id, p.username::text, p.nickname::text, p.avatar_url::text, f.created_at
    from public.friendships f
    cross join lateral (select case when f.user_a = me then f.user_b else f.user_a end as id) o
    left join public.users_profile p on p.id = o.id
    where me in (f.user_a, f.user_b)
    order by coalesce(nullif(p.nickname, ''), p.username) nulls last;
end $$;

-- 요청 관리: 받은 요청(dir='in') · 보낸 요청(dir='out')
create or replace function public.friend_requests_list()
returns table (id uuid, dir text, user_id uuid, username text, nickname text, avatar_url text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare me uuid := public.meow_me(false);
begin
  return query
    select r.id, case when r.to_id = me then 'in' else 'out' end, o.id, p.username::text, p.nickname::text, p.avatar_url::text, r.created_at
    from public.friend_requests r
    cross join lateral (select case when r.to_id = me then r.from_id else r.to_id end as id) o
    left join public.users_profile p on p.id = o.id
    where me in (r.from_id, r.to_id)
    order by r.created_at desc;
end $$;

-- 메일 보내기 (친구에게만)
create or replace function public.mail_send(p_to uuid, p_subject text, p_body text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(); mid uuid;
begin
  if not public.meow_are_friends(me, p_to) then raise exception 'NOT_FRIENDS'; end if;
  if char_length(trim(coalesce(p_subject, ''))) = 0 or char_length(trim(coalesce(p_body, ''))) = 0 then raise exception 'EMPTY'; end if;
  insert into public.mails (from_id, to_id, subject, body) values (me, p_to, left(trim(p_subject), 100), left(p_body, 5000)) returning id into mid;
  perform public.meow_notify(p_to, 'mail', me, mid);
  return mid;
end $$;

-- 메일함: p_box = 'in'(받은 메일) | 'out'(보낸 메일)
create or replace function public.mail_list(p_box text default 'in', p_limit int default 100)
returns table (id uuid, other_id uuid, username text, nickname text, avatar_url text, subject text, preview text, created_at timestamptz, read_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare me uuid := public.meow_me(false);
begin
  return query
    select m.id, case when p_box = 'out' then m.to_id else m.from_id end, p.username::text, p.nickname::text, p.avatar_url::text,
           m.subject, left(regexp_replace(m.body, '\s+', ' ', 'g'), 80), m.created_at, m.read_at
    from public.mails m
    left join public.users_profile p on p.id = case when p_box = 'out' then m.to_id else m.from_id end
    where case when p_box = 'out' then m.from_id = me and not m.del_by_sender else m.to_id = me and not m.del_by_recipient end
    order by m.created_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 300);
end $$;

-- 메일 한 통 열기 (받은 메일이면 읽음 표시)
create or replace function public.mail_get(p_id uuid)
returns table (id uuid, dir text, other_id uuid, username text, nickname text, avatar_url text, subject text, body text, created_at timestamptz, read_at timestamptz)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare me uuid := public.meow_me(false);
begin
  update public.mails m set read_at = now() where m.id = p_id and m.to_id = me and m.read_at is null;
  update public.notifications n set read_at = now() where n.user_id = me and n.kind = 'mail' and n.ref_id = p_id and n.read_at is null;
  return query
    select m.id, case when m.to_id = me then 'in' else 'out' end, o.id, p.username::text, p.nickname::text, p.avatar_url::text, m.subject, m.body, m.created_at, m.read_at
    from public.mails m
    cross join lateral (select case when m.to_id = me then m.from_id else m.to_id end as id) o
    left join public.users_profile p on p.id = o.id
    where m.id = p_id and ((m.to_id = me and not m.del_by_recipient) or (m.from_id = me and not m.del_by_sender));
end $$;

-- 메일 지우기 (내 메일함에서만 사라져요)
create or replace function public.mail_delete(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false);
begin
  update public.mails set del_by_recipient = true where id = p_id and to_id = me;
  update public.mails set del_by_sender = true where id = p_id and from_id = me;
  delete from public.mails where id = p_id and (del_by_sender or from_id is null) and del_by_recipient;
end $$;

-- 알림 목록
create or replace function public.notif_list(p_limit int default 50)
returns table (id uuid, kind text, actor_id uuid, username text, nickname text, avatar_url text, ref_id uuid, created_at timestamptz, read_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare me uuid := public.meow_me(false);
begin
  return query
    select n.id, n.kind, n.actor_id, p.username::text, p.nickname::text, p.avatar_url::text, n.ref_id, n.created_at, n.read_at
    from public.notifications n left join public.users_profile p on p.id = n.actor_id
    where n.user_id = me
    order by n.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

-- 알림 읽음 (p_ids 가 null 이면 모두)
create or replace function public.notif_read(p_ids uuid[] default null)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false);
begin
  update public.notifications set read_at = now() where user_id = me and read_at is null and (p_ids is null or id = any(p_ids));
end $$;

-- 알림 지우기 (p_ids 가 null 이면 모두)
create or replace function public.notif_delete(p_ids uuid[] default null)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.meow_me(false);
begin
  delete from public.notifications where user_id = me and (p_ids is null or id = any(p_ids));
end $$;

-- 6) 실행 권한: 도우미는 막고, 앱용 함수는 로그인한 사용자만
revoke execute on function public.meow_is_premium(uuid), public.meow_me(boolean), public.meow_are_friends(uuid, uuid), public.meow_notify(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_me(), public.social_settings(boolean, jsonb), public.friend_request(text), public.friend_respond(uuid, boolean),
  public.friend_cancel(uuid), public.friend_remove(uuid), public.friend_list(), public.friend_requests_list(), public.mail_send(uuid, text, text),
  public.mail_list(text, int), public.mail_get(uuid), public.mail_delete(uuid), public.notif_list(int), public.notif_read(uuid[]), public.notif_delete(uuid[]) from public, anon;
grant execute on function public.social_me(), public.social_settings(boolean, jsonb), public.friend_request(text), public.friend_respond(uuid, boolean),
  public.friend_cancel(uuid), public.friend_remove(uuid), public.friend_list(), public.friend_requests_list(), public.mail_send(uuid, text, text),
  public.mail_list(text, int), public.mail_get(uuid), public.mail_delete(uuid), public.notif_list(int), public.notif_read(uuid[]), public.notif_delete(uuid[]) to authenticated;

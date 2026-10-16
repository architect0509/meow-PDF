-- Supabase SQL Editor 에서 한 번 실행하세요.
-- 목적: 결제/학생 권한(is_paid, is_student)을 "서버/DB 만" 바꿀 수 있게 잠그기

-- 1) 프로필 테이블 (이미 있으면 컬럼만 추가돼요)
create table if not exists public.users_profile (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  is_student boolean not null default false,
  student_verified_at timestamptz,
  is_paid boolean not null default false,
  paid_at timestamptz,
  last_order_id text,
  last_payment_key text
);
alter table public.users_profile add column if not exists is_paid boolean not null default false;
alter table public.users_profile add column if not exists paid_at timestamptz;
alter table public.users_profile add column if not exists last_order_id text;
alter table public.users_profile add column if not exists last_payment_key text;

-- 2) RLS: 로그인한 사용자는 "자기 행을 읽기만" 가능. 쓰기 정책을 만들지 않으므로
--    브라우저(앱)에서는 is_paid / is_student 를 절대 바꿀 수 없어요.
--    (서버의 service_role 키는 RLS 를 우회해서 쓸 수 있어요)
alter table public.users_profile enable row level security;
drop policy if exists "own profile read" on public.users_profile;
create policy "own profile read" on public.users_profile for select to authenticated using (auth.uid() = id);
-- 예전에 만들어 둔 쓰기 정책이 있다면 지워 주세요:
-- drop policy "정책이름" on public.users_profile;

-- 3) 학교 이메일로 인증을 마치면 DB 가 직접 is_student 를 기록 (앱 코드는 못 건드려요)
create or replace function public.sync_student_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null and new.email ~* '\.(ac\.kr|edu)$' then
    insert into public.users_profile (id, email, is_student, student_verified_at)
    values (new.id, new.email, true, new.email_confirmed_at)
    on conflict (id) do update set email = excluded.email, is_student = true,
      student_verified_at = coalesce(public.users_profile.student_verified_at, excluded.student_verified_at);
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_student on auth.users;
create trigger on_auth_user_student after insert or update of email_confirmed_at, email on auth.users
  for each row execute function public.sync_student_profile();

-- 4) 이용 키 (개발자 계정이 서버를 통해 발급 → 발급일로부터 3개월간 프리미엄)
alter table public.users_profile add column if not exists premium_until timestamptz;
-- 프리미엄을 받은 방식: 'paid'(결제) 또는 'key'(이용 키). 화면에 구분해서 보여줘요.
alter table public.users_profile add column if not exists premium_source text;

create table if not exists public.access_keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text unique not null,          -- 키 원문은 저장하지 않고 해시만 저장해요
  hint text,                              -- 키 끝 4자리 (목록 확인용)
  note text,
  issued_by text,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked boolean not null default false
);
create table if not exists public.key_redemptions (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references public.access_keys(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  unique (key_id, user_id)
);
-- 정책을 만들지 않으므로 브라우저(앱)에서는 접근할 수 없고, 서버(service_role)만 읽고 쓸 수 있어요.
alter table public.access_keys enable row level security;
alter table public.key_redemptions enable row level security;

-- 발급한 키를 개발자가 다시 볼 수 있도록 (서버가 암호화해서 저장해요. 원문은 DB에 그대로 저장되지 않아요)
alter table public.access_keys add column if not exists key_enc text;

-- 고객센터: 불편사항 · 의견 접수 (서버만 읽고 쓰며, 개발자 계정이 설정 창에서 조회/관리해요)
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  category text not null default '기타',
  title text,
  message text not null,
  contact text,
  user_id uuid,
  user_email text,
  app_version text,
  env text,
  status text not null default 'new' check (status in ('new','doing','done')),
  memo text
);
create index if not exists feedback_created_idx on public.feedback (created_at desc);
alter table public.feedback enable row level security;


-- ─────────────────────────────────────────────────────────────
-- 5) 아이디 · 닉네임 · 프로필 사진 (v0.8.3)
--    이미 위쪽 1~4번을 실행했다면 이 5번 부분만 따로 실행해도 돼요. (여러 번 실행해도 안전해요)
-- ─────────────────────────────────────────────────────────────
alter table public.users_profile add column if not exists username text;     -- 로그인 아이디 (영문 소문자·숫자·_ 4~20자)
alter table public.users_profile add column if not exists nickname text;     -- 화면에 보이는 이름
alter table public.users_profile add column if not exists avatar_url text;   -- 프로필 사진 주소

-- 아이디는 대소문자 구분 없이 중복 불가
create unique index if not exists users_profile_username_key on public.users_profile (lower(username)) where username is not null;
do $$ begin
  alter table public.users_profile add constraint users_profile_username_fmt
    check (username is null or username ~ '^[a-z0-9_]{4,20}$') not valid;   -- 이미 있는 행은 검사하지 않아요
exception when duplicate_object then null; end $$;

-- 가입할 때 앱이 보낸 아이디/닉네임을 프로필에 저장. 아이디가 겹치면 가입이 거절돼요.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  u text := lower(nullif(trim(new.raw_user_meta_data->>'username'), ''));
  n text := nullif(trim(new.raw_user_meta_data->>'nickname'), '');
begin
  if u is not null and u !~ '^[a-z0-9_]{4,20}$' then
    raise exception 'invalid_username';
  end if;
  insert into public.users_profile (id, email, username, nickname)
  values (new.id, new.email, u, left(n, 20))
  on conflict (id) do update set
    email = excluded.email,
    username = coalesce(public.users_profile.username, excluded.username),
    nickname = coalesce(public.users_profile.nickname, excluded.nickname);
  return new;
end $$;
drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile after insert on auth.users
  for each row execute function public.handle_new_user();

-- 내 닉네임 바꾸기 / (아직 아이디가 없는 기존 계정만) 아이디 정하기
create or replace function public.set_my_profile(p_nickname text default null, p_username text default null) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); u text := lower(nullif(trim(p_username), ''));
begin
  if uid is null then raise exception 'not_logged_in'; end if;
  if p_nickname is not null then
    update public.users_profile set nickname = left(nullif(trim(p_nickname), ''), 20) where id = uid;
  end if;
  if u is not null then
    if u !~ '^[a-z0-9_]{4,20}$' then raise exception 'invalid_username'; end if;
    update public.users_profile set username = u where id = uid and username is null;
  end if;
end $$;
revoke all on function public.set_my_profile(text, text) from public, anon;
grant execute on function public.set_my_profile(text, text) to authenticated;

-- 내 프로필 사진 주소 저장 (내 폴더에 올린 사진 주소만 받아요)
create or replace function public.set_my_avatar(p_url text) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_logged_in'; end if;
  if p_url is not null and p_url not like '%/avatars/' || uid::text || '/%' then raise exception 'invalid_avatar'; end if;
  update public.users_profile set avatar_url = p_url where id = uid;
end $$;
revoke all on function public.set_my_avatar(text) from public, anon;
grant execute on function public.set_my_avatar(text) to authenticated;

-- 프로필 사진 저장소 (공개 읽기 · 본인 폴더에만 올리기, 2MB, jpg/png/webp)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg','image/png','image/webp'];
drop policy if exists "avatar read" on storage.objects;
create policy "avatar read" on storage.objects for select using (bucket_id = 'avatars');
drop policy if exists "avatar insert own" on storage.objects;
create policy "avatar insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatar update own" on storage.objects;
create policy "avatar update own" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatar delete own" on storage.objects;
create policy "avatar delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

notify pgrst, 'reload schema';

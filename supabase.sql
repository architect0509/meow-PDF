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

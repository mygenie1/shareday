-- 셰어데이 스키마. Neon SQL 에디터에 붙여넣어 실행하세요.
-- 개인 일정은 서버에 저장하지 않습니다. 여기에는 공개 스냅샷 · 코멘트 · 공휴일 캐시만 둡니다.

-- 공개 스냅샷: 공유 링크 하나 = 한 행
create table if not exists share_links (
  token          text primary key,            -- 추측 불가한 랜덤 토큰
  events         jsonb not null,              -- isPrivate=false 인 일정만 담김
  categories     jsonb not null default '[]', -- 스냅샷에 쓰인 카테고리(이름/색) 사본
  allow_comments boolean not null default true,
  expires_at     timestamptz,                 -- null이면 무기한
  revoked        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 코멘트: 비로그인 작성
create table if not exists comments (
  id          bigint generated always as identity primary key,
  token       text not null references share_links(token) on delete cascade,
  event_id    text not null,                  -- 스냅샷 내 일정 id
  author_name text not null,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists comments_token_event_idx on comments (token, event_id);

-- 공휴일 캐시(연 1~2회 갱신)
create table if not exists holidays (
  date       date primary key,                -- YYYY-MM-DD
  name       text not null,
  is_holiday boolean not null default true
);

// 데이터베이스 표 정의. 서버가 처음 켜질 때 한 번 실행됩니다 (이미 있으면 건너뜀).
// 계획과 할 일은 같은 것입니다: 'tasks' 표의 한 줄이 곧 계획(할 일) 하나입니다.
// 날짜 규칙: 날짜(date)는 서울 기준 'YYYY-MM-DD', 시각(timestamptz)은 UTC로 저장하고 화면에서 서울 시간으로 보여 줍니다.
// 단위 규칙: 모든 시간 값은 '분' 정수입니다.
module.exports = `
-- 예전 버전(계획 표와 할 일 표가 따로 있던 구조)이 남아 있으면 새 구조로 바꾸기 위해 비웁니다.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = current_schema() and table_name = 'tasks' and column_name = 'plan_id') then
    drop table if exists reviews, runs, completions, plan_revisions, tasks, plans cascade;
  end if;
end $$;

-- 회원: 비밀번호는 복원할 수 없는 해시(scrypt)로만 저장합니다. 아이디는 소문자로 통일해 중복 가입을 막습니다.
create table if not exists users (
  id integer generated always as identity primary key,
  username text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists users_username_uniq on users (lower(username));

-- 로그인 세션: 브라우저에는 무작위 값(쿠키)만 주고, 서버에는 그 값의 SHA-256 해시만 둡니다. 만료 시각이 있습니다.
create table if not exists sessions (
  token_hash text primary key,
  user_id integer not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists tasks (
  id integer generated always as identity primary key,
  user_id integer references users(id) on delete cascade,
  title text not null,
  start_date date,
  due_date date,
  priority smallint not null default 2 check (priority between 1 and 3),
  tags text not null default '',
  success_criteria text not null default '',
  estimated_minutes integer not null default 0 check (estimated_minutes >= 0),
  status text not null default 'doing' check (status in ('doing','done')),
  done_at timestamptz,
  carried_lesson text,
  carried_from_review_id integer,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_date is null or due_date is null or due_date >= start_date)
);

-- 처음 세운 계획(버전 1)과 고친 기록. 현재 값을 고쳐도 이 표의 옛 줄은 바뀌지 않습니다.
create table if not exists task_revisions (
  id integer generated always as identity primary key,
  task_id integer not null references tasks(id) on delete cascade,
  version integer not null,
  title text not null,
  start_date date,
  due_date date,
  priority smallint not null,
  tags text not null default '',
  success_criteria text not null,
  estimated_minutes integer not null,
  change_note text not null default '',
  changed_at timestamptz not null default now(),
  unique (task_id, version)
);

create table if not exists completions (
  id integer generated always as identity primary key,
  task_id integer not null references tasks(id) on delete cascade,
  idempotency_key text not null unique,
  completed_at timestamptz not null default now(),
  reverted_at timestamptz
);
create unique index if not exists completions_one_active on completions (task_id) where reverted_at is null;

create table if not exists runs (
  id integer generated always as identity primary key,
  task_id integer not null references tasks(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  actual_minutes integer not null check (actual_minutes >= 0),
  blocked_reason text not null default '',
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  check (ended_at >= started_at)
);

create table if not exists reviews (
  id integer generated always as identity primary key,
  period_from date,
  period_to date,
  snapshot jsonb not null,
  lesson text not null,
  next_task_id integer references tasks(id) on delete set null,
  created_at timestamptz not null default now()
);

-- 6번에서 만든 예전 표에는 주인(user_id) 칸을 덧붙입니다. (기존 자료는 이관 스크립트가 내 계정으로 옮깁니다)
alter table tasks add column if not exists user_id integer references users(id) on delete cascade;
alter table reviews add column if not exists user_id integer references users(id) on delete cascade;

-- 5일 관찰: 질문·지표·단위·계산 규칙은 처음 한 번 정하면 바꾸지 않습니다.
create table if not exists experiments (
  user_id integer primary key references users(id) on delete cascade,
  question text not null,
  metric text not null,
  unit text not null,
  calc_rule text not null,
  missing_rule text not null,
  duplicate_rule text not null,
  outlier_rule text not null,
  rounding_rule text not null,
  week_start text not null,
  plan_rule text not null,
  max_per_day integer not null check (max_per_day between 1 and 50),
  rule_version integer not null default 1,
  created_at timestamptz not null default now()
);

-- 하루 마감 기록 (날짜는 서울 기준). 하루 한 줄이고, 최대 5일입니다.
create table if not exists day_logs (
  id integer generated always as identity primary key,
  user_id integer not null references users(id) on delete cascade,
  day_no smallint not null check (day_no between 1 and 5),
  log_date date not null,
  done_count integer not null check (done_count >= 0),
  planned_count integer not null check (planned_count >= 0),
  rule_version integer not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (user_id, day_no),
  unique (user_id, log_date)
);

-- 계획 규칙 바꾼 기록: 2일차 뒤, 3일차 앞에서 딱 한 번. 1일차·2일차 기록을 가리킵니다.
create table if not exists rule_changes (
  id integer generated always as identity primary key,
  user_id integer not null unique references users(id) on delete cascade,
  changed_at timestamptz not null default now(),
  old_rule text not null,
  new_rule text not null,
  old_max integer not null,
  new_max integer not null,
  reason text not null,
  day1_log_id integer not null references day_logs(id) on delete cascade,
  day2_log_id integer not null references day_logs(id) on delete cascade
);

create index if not exists tasks_due_idx on tasks (due_date) where deleted_at is null;
create index if not exists tasks_user_idx on tasks (user_id);
create index if not exists runs_task_idx on runs (task_id);

alter table users enable row level security;
alter table sessions enable row level security;
alter table experiments enable row level security;
alter table day_logs enable row level security;
alter table rule_changes enable row level security;
alter table tasks enable row level security;
alter table task_revisions enable row level security;
alter table completions enable row level security;
alter table runs enable row level security;
alter table reviews enable row level security;
`;

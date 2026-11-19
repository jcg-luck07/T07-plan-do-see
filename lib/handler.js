// 모든 /api/* 요청을 처리합니다.
const { getDb } = require('./db');
const auth = require('./auth');

const TODAY_SEOUL = "(now() at time zone 'Asia/Seoul')::date";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);

// ---------- 입력 검사 ----------
function str(v, name, { max = 300, required = false } = {}) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (required && !s) throw bad(`${name}을(를) 입력하세요.`);
  if (s.length > max) throw bad(`${name}은(는) ${max}자 이하로 적어 주세요.`);
  return s;
}
function date(v, name, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name}을(를) 입력하세요.`);
    return null;
  }
  if (!DATE_RE.test(String(v)) || Number.isNaN(Date.parse(v))) throw bad(`${name}은(는) YYYY-MM-DD 형식이어야 합니다.`);
  return String(v);
}
function int(v, name, { min = 0, max = 100000, def = 0 } = {}) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name}은(는) ${min}~${max} 사이의 정수여야 합니다.`);
  return n;
}
function prio(v) {
  return int(v, '우선순위', { min: 1, max: 3, def: 2 });
}
function tags(v) {
  const arr = (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean);
  const uniq = [...new Set(arr)];
  if (uniq.length > 10) throw bad('태그는 10개까지 넣을 수 있습니다.');
  if (uniq.some((t) => t.length > 30)) throw bad('태그 하나는 30자 이하여야 합니다.');
  return uniq.join(',');
}
// 시각: 시간대 표시가 없으면 서울(+09:00)로 봅니다.
function instant(v, name) {
  if (!v) throw bad(`${name}을(를) 입력하세요.`);
  let s = String(v).trim();
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += s.length === 16 ? ':00+09:00' : '+09:00';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw bad(`${name} 형식이 올바르지 않습니다.`);
  return d.toISOString();
}
function idParam(s) {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw bad('번호가 올바르지 않습니다.');
  return n;
}

// ---------- 공통 SQL 조각 ----------
// 계획과 할 일은 같은 것: tasks 표의 한 줄이 계획(할 일) 하나입니다.
const TASK_COLS = `t.id, t.title, t.start_date::text as start_date, t.due_date::text as due_date, t.priority, t.tags,
  t.success_criteria, t.estimated_minutes, t.status, t.done_at, t.carried_lesson, t.carried_from_review_id, t.created_at,
  coalesce((select sum(r.actual_minutes) from runs r where r.task_id = t.id), 0)::int as actual_minutes,
  (select count(*) from runs r where r.task_id = t.id)::int as run_count,
  exists (select 1 from runs r where r.task_id = t.id and btrim(r.blocked_reason) <> '') as blocked,
  (select r.blocked_reason from runs r where r.task_id = t.id and btrim(r.blocked_reason) <> ''
     order by r.started_at desc, r.id desc limit 1) as last_blocked_reason,
  (t.status <> 'done' and t.due_date is not null and t.due_date < ${TODAY_SEOUL}) as late`;

const SORTS = {
  due: ['t.due_date', 'asc nulls last'],
  priority: ['t.priority', 'asc'],
  estimate: ['t.estimated_minutes', 'asc'],
  created: ['t.created_at', 'asc'],
  title: ['t.title', 'asc'],
};

// ---------- 계획(할 일) 입력 ----------
function taskInput(b) {
  const due = date(b.due_date, '마감일');
  const f = {
    title: str(b.title, '계획(할 일) 이름', { required: true, max: 150 }),
    start_date: date(b.start_date, '시작일') || due, // 시작일을 비우면 마감일과 같은 날
    due_date: due,
    priority: prio(b.priority),
    tags: tags(b.tags),
    success_criteria: str(b.success_criteria, '성공 기준', { max: 500 }),
    estimated_minutes: int(b.estimated_minutes, '예상 시간(분)', { max: 600000 }),
  };
  if (f.start_date && f.due_date && f.due_date < f.start_date) throw bad('마감일은 시작일보다 빠를 수 없습니다.');
  return f;
}

// 새로 만들면서 '처음 세운 계획'(버전 1)을 같은 문장 안에서 함께 남깁니다.
async function insertTask(db, uid, f, extra = {}) {
  await checkDayLimit(db, uid, f.due_date, null);
  const rows = await db.query(
    `with t as (
       insert into tasks (user_id, title, start_date, due_date, priority, tags, success_criteria, estimated_minutes, carried_lesson, carried_from_review_id)
       values ($10, $1, $2::date, $3::date, $4, $5, $6, $7, $8, $9) returning *
     ), r as (
       insert into task_revisions (task_id, version, title, start_date, due_date, priority, tags, success_criteria, estimated_minutes, change_note)
       select id, 1, title, start_date, due_date, priority, tags, success_criteria, estimated_minutes, '처음 세운 계획' from t
       returning task_id
     ) select id from t`,
    [f.title, f.start_date, f.due_date, f.priority, f.tags, f.success_criteria, f.estimated_minutes,
      extra.carried_lesson ?? null, extra.carried_from_review_id ?? null, uid]);
  return rows[0].id;
}

// 고칠 때는 현재 값만 바꾸고, 바꾼 뒤의 값을 새 버전으로 이력에 더합니다. 버전 1(처음 계획)은 그대로입니다.
async function updateTask(db, uid, id, b) {
  const f = taskInput(b);
  await checkDayLimit(db, uid, f.due_date, id);
  const note = str(b.change_note, '고친 이유', { max: 300 });
  const rows = await db.query(
    `with u as (
       update tasks set title=$2, start_date=$3::date, due_date=$4::date, priority=$5, tags=$6,
         success_criteria=$7, estimated_minutes=$8, updated_at=now()
       where id=$1 and user_id=$10 and deleted_at is null returning *
     ), r as (
       insert into task_revisions (task_id, version, title, start_date, due_date, priority, tags, success_criteria, estimated_minutes, change_note)
       select u.id, (select coalesce(max(version),0)+1 from task_revisions where task_id=u.id),
         u.title, u.start_date, u.due_date, u.priority, u.tags, u.success_criteria, u.estimated_minutes, $9
       from u returning task_id
     ) select id from u`,
    [id, f.title, f.start_date, f.due_date, f.priority, f.tags, f.success_criteria, f.estimated_minutes, note, uid]);
  if (!rows.length) throw new HttpError(404, '계획(할 일)을 찾을 수 없습니다.');
}

function taskFilterSql(q, params, uid) {
  // 소유자 조건: 목록·통계·돌아보기 모든 조회가 이 함수를 거치므로 남의 자료가 섞이지 않습니다.
  params.push(uid);
  const where = ['t.deleted_at is null', `t.user_id = $${params.length}`];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (q.q) add("position(lower(?::text) in lower(t.title || ' ' || t.tags)) > 0", String(q.q).slice(0, 100));
  if (q.status === 'doing' || q.status === 'done') add('t.status = ?', q.status);
  if (q.priority) add('t.priority = ?::int', prio(q.priority));
  if (q.tag) add("?::text = any(string_to_array(t.tags, ','))", String(q.tag).trim().toLowerCase());
  if (q.late === '1') where.push(`(t.status <> 'done' and t.due_date is not null and t.due_date < ${TODAY_SEOUL})`);
  if (q.blocked === '1') where.push("exists (select 1 from runs r where r.task_id = t.id and btrim(r.blocked_reason) <> '')");
  if (q.from) add('t.due_date >= ?::date', date(q.from, '시작 날짜'));
  if (q.to) add('t.due_date <= ?::date', date(q.to, '끝 날짜'));
  return where.join(' and ');
}

async function listTasks(db, uid, q) {
  const params = [];
  const where = taskFilterSql(q, params, uid);
  const [col, defDir] = SORTS[q.sort] || SORTS.due;
  let order = `${col} ${defDir}`;
  if (q.dir === 'desc') order = `${col} ${defDir.includes('nulls') ? 'desc nulls last' : 'desc'}`;
  // 값이 같으면 번호(id) 순 → 볼 때마다 순서가 달라지지 않음
  return db.query(`select ${TASK_COLS} from tasks t where ${where} order by ${order}, t.id asc`, params);
}

async function getTask(db, uid, id) {
  // 다른 계정 자료는 '없는 자료'와 똑같이 404로 답합니다 (존재 자체를 감춤)
  const [task] = await db.query(`select ${TASK_COLS} from tasks t where t.id = $1 and t.user_id = $2 and t.deleted_at is null`, [id, uid]);
  if (!task) throw new HttpError(404, '계획(할 일)을 찾을 수 없습니다.');
  task.runs = await db.query(
    `select id, task_id, started_at, ended_at, actual_minutes, blocked_reason, created_at
     from runs where task_id = $1 order by started_at, id`, [id]);
  task.revisions = await db.query(
    `select version, title, start_date::text as start_date, due_date::text as due_date, priority, tags,
      success_criteria, estimated_minutes, change_note, changed_at
     from task_revisions where task_id = $1 order by version`, [id]);
  return task;
}

async function completeTask(db, uid, id, b) {
  const key = str(b.idempotency_key, '요청 키', { required: true, max: 100 });
  // 한 문장으로 처리: 같은 키이거나 이미 완료 기록이 있으면 새로 쌓지 않음 (DB 제약이 최종 방어선)
  const rows = await db.query(
    `with t as (select id from tasks where id = $1 and user_id = $3 and deleted_at is null),
     ins as (
       insert into completions (task_id, idempotency_key)
       select id, $2 from t
       on conflict do nothing
       returning id
     ),
     upd as (
       update tasks set status = 'done', done_at = coalesce(done_at, now()), updated_at = now()
       where id in (select id from t) returning id
     )
     select (select count(*) from ins)::int as created, (select count(*) from t)::int as found`,
    [id, key, uid]);
  if (!rows[0].found) throw new HttpError(404, '계획(할 일)을 찾을 수 없습니다.');
  return { created: rows[0].created === 1, task: await getTask(db, uid, id) };
}

async function reopenTask(db, uid, id) {
  const rows = await db.query(
    `with t as (select id from tasks where id = $1 and user_id = $2 and deleted_at is null),
     c as (update completions set reverted_at = now() where task_id in (select id from t) and reverted_at is null returning id),
     u as (update tasks set status = 'doing', done_at = null, updated_at = now() where id in (select id from t) returning id)
     select (select count(*) from t)::int as found`, [id, uid]);
  if (!rows[0].found) throw new HttpError(404, '계획(할 일)을 찾을 수 없습니다.');
  return getTask(db, uid, id);
}

// ---------- 실행 기록 ----------
async function addRun(db, uid, taskId, b) {
  const started = instant(b.started_at, '시작 시각');
  const ended = instant(b.ended_at, '끝난 시각');
  if (ended < started) throw bad('끝난 시각은 시작 시각보다 빠를 수 없습니다.');
  const diff = Math.round((Date.parse(ended) - Date.parse(started)) / 60000);
  const minutes = b.actual_minutes === undefined || b.actual_minutes === '' || b.actual_minutes === null
    ? diff : int(b.actual_minutes, '실제 걸린 시간(분)', { max: 600000 });
  const reason = str(b.blocked_reason, '막혔던 이유', { max: 500 });
  const key = b.idempotency_key ? str(b.idempotency_key, '요청 키', { max: 100 }) : null;
  const [task] = await db.query('select id from tasks where id = $1 and user_id = $2 and deleted_at is null', [taskId, uid]);
  if (!task) throw new HttpError(404, '계획(할 일)을 찾을 수 없습니다.');
  const rows = await db.query(
    `insert into runs (task_id, started_at, ended_at, actual_minutes, blocked_reason, idempotency_key)
     values ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6)
     on conflict (idempotency_key) do nothing returning id`,
    [taskId, started, ended, minutes, reason, key]);
  return { created: rows.length === 1, task: await getTask(db, uid, taskId) };
}

// ---------- 돌아보기 ----------
async function computeReview(db, uid, q) {
  const params = [];
  const where = taskFilterSql({ from: q.from, to: q.to }, params, uid);
  const [r] = await db.query(
    `with base as (select t.* from tasks t where ${where})
     select
       count(*)::int as planned,
       (count(*) filter (where status = 'done'))::int as done,
       (count(*) filter (where status <> 'done' and due_date is not null and due_date < ${TODAY_SEOUL}))::int as late,
       (count(*) filter (where exists (select 1 from runs r where r.task_id = base.id and btrim(r.blocked_reason) <> '')))::int as blocked,
       coalesce(sum(estimated_minutes), 0)::int as estimated_minutes,
       coalesce((select sum(r.actual_minutes) from runs r where r.task_id in (select id from base)), 0)::int as actual_minutes
     from base`, params);
  return { ...r, diff_minutes: r.actual_minutes - r.estimated_minutes };
}

async function carryOver(db, uid, b) {
  const lesson = str(b.lesson, '고칠 점', { required: true, max: 300 });
  const from = date(b.from, '시작 날짜');
  const to = date(b.to, '끝 날짜');
  const snapshot = await computeReview(db, uid, { from, to });
  const next = taskInput({
    title: b.next_title || `다음 계획: ${lesson}`.slice(0, 150),
    start_date: b.next_start_date,
    due_date: b.next_due_date,
    priority: b.next_priority,
    tags: b.next_tags,
    success_criteria: b.next_success_criteria || `지난 돌아보기에서 정한 고칠 점을 지킨다: ${lesson}`.slice(0, 500),
    estimated_minutes: b.next_estimated_minutes,
  });
  const [rev] = await db.query(
    `insert into reviews (user_id, period_from, period_to, snapshot, lesson)
     values ($5, $1::date, $2::date, $3::jsonb, $4) returning id`,
    [from, to, JSON.stringify(snapshot), lesson, uid]);
  const nextId = await insertTask(db, uid, next, { carried_lesson: lesson, carried_from_review_id: rev.id });
  await db.query('update reviews set next_task_id = $1 where id = $2 and user_id = $3', [nextId, rev.id, uid]);
  return { review_id: rev.id, next_task_id: nextId };
}

async function listReviews(db, uid) {
  return db.query(
    `select id, period_from::text as period_from, period_to::text as period_to,
      snapshot, lesson, next_task_id, created_at from reviews where user_id = $1 order by id desc`, [uid]);
}

// ---------- 5일 관찰 (질문·지표·규칙) ----------
const FIXED_RULES = {
  metric: '일별 계획 완료 개수',
  unit: '개',
  calc_rule: '그날(서울 기준) 달성으로 체크된 계획의 개수. 하루 마감 때 한 번 세어 기록하고, 5일 합계와 평균은 그 기록들로 계산한다.',
  missing_rule: '마감 기록이 없는 날은 0으로 치지 않고 평균 계산에서 뺀다 (화면에는 "기록 없음"으로 보인다).',
  duplicate_rule: '같은 날짜를 다시 마감하면 새 줄을 만들지 않고 그 날짜의 기록을 마지막 값으로 덮어쓴다.',
  outlier_rule: '하루 완료 개수가 20개를 넘으면 입력 오류일 수 있어 "이상값"으로 표시만 하고, 합계·평균에서는 빼지 않는다.',
  rounding_rule: '평균은 소수 둘째 자리에서 반올림해 소수 첫째 자리까지 보인다 (5는 올림).',
  week_start: '월요일',
};
const OUTLIER_MIN = 20;

// 반올림(5는 올림): 합계 x 10 / 개수 를 정수 계산으로 처리해 소수 오차가 없게 함
const avg1 = (sum, n) => (n ? Math.floor((sum * 20 + n) / (2 * n)) / 10 : null);

// 계획 규칙: 하루(마감일 기준)에 세울 수 있는 계획 수. 서버가 저장 전에 확인합니다.
async function checkDayLimit(db, uid, dueDate, excludeId) {
  if (!dueDate) return;
  const [ex] = await db.query('select max_per_day from experiments where user_id = $1', [uid]);
  if (!ex) return;
  const [r] = await db.query(
    'select count(*)::int as n from tasks where user_id = $1 and due_date = $2::date and deleted_at is null and ($3::int is null or id <> $3::int)',
    [uid, dueDate, excludeId]);
  if (r.n >= ex.max_per_day) throw bad('계획 규칙: 하루(마감일 기준)에 계획은 ' + ex.max_per_day + '개까지 세울 수 있어요.');
}

async function getExperiment(db, uid) {
  const [ex] = await db.query('select * from experiments where user_id = $1', [uid]);
  if (!ex) return { experiment: null };
  const logs = await db.query(
    'select id, day_no, log_date::text as log_date, done_count, planned_count, rule_version, note, created_at from day_logs where user_id = $1 order by day_no', [uid]);
  const [change] = await db.query(
    'select id, changed_at, old_rule, new_rule, old_max, new_max, reason, day1_log_id, day2_log_id from rule_changes where user_id = $1', [uid]);
  const part = (list) => {
    const total = list.reduce((a, l) => a + l.done_count, 0);
    return { days: list.length, total, average: avg1(total, list.length) };
  };
  const before = part(logs.filter((l) => l.rule_version === 1));
  const after = part(logs.filter((l) => l.rule_version === 2));
  return {
    experiment: ex,
    logs: logs.map((l) => ({ ...l, outlier: l.done_count > OUTLIER_MIN })),
    rule_change: change || null,
    summary: {
      metric: ex.metric, unit: ex.unit, ...part(logs),
      before, after,
      diff: before.average !== null && after.average !== null ? Math.round((after.average - before.average) * 10) / 10 : null,
    },
  };
}

async function createExperiment(db, uid, b) {
  const question = str(b.question, '1일차 질문', { required: true, max: 200 });
  const plan_rule = str(b.plan_rule, '계획 규칙', { required: true, max: 200 });
  const max = int(b.max_per_day, '하루 최대 계획 수', { min: 1, max: 50, def: 5 });
  const rows = await db.query(
    `insert into experiments (user_id, question, metric, unit, calc_rule, missing_rule, duplicate_rule, outlier_rule, rounding_rule, week_start, plan_rule, max_per_day)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (user_id) do nothing returning user_id`,
    [uid, question, FIXED_RULES.metric, FIXED_RULES.unit, FIXED_RULES.calc_rule, FIXED_RULES.missing_rule, FIXED_RULES.duplicate_rule,
      FIXED_RULES.outlier_rule, FIXED_RULES.rounding_rule, FIXED_RULES.week_start, plan_rule, max]);
  if (!rows.length) throw new HttpError(409, '1일차 질문과 지표는 한 번 정하면 바꿀 수 없어요.');
  return getExperiment(db, uid);
}

// 하루 마감: 오늘(서울) 달성으로 체크된 계획 수를 세어 한 줄로 남깁니다.
async function closeDay(db, uid, b) {
  const [ex] = await db.query('select rule_version from experiments where user_id = $1', [uid]);
  if (!ex) throw bad('먼저 1일차 질문과 지표를 정하세요.');
  const note = str(b.note, '메모', { max: 300 });
  const [t] = await db.query(`select ${TODAY_SEOUL}::text as d,
    (select count(*) from completions c join tasks k on k.id = c.task_id
      where k.user_id = $1 and c.reverted_at is null and (c.completed_at at time zone 'Asia/Seoul')::date = ${TODAY_SEOUL})::int as done,
    (select count(*) from tasks where user_id = $1 and deleted_at is null and due_date = ${TODAY_SEOUL})::int as planned`, [uid]);
  const [last] = await db.query('select day_no, log_date::text as d from day_logs where user_id = $1 order by day_no desc limit 1', [uid]);
  const [same] = await db.query('select id from day_logs where user_id = $1 and log_date = $2::date', [uid, t.d]);
  if (same) {
    await db.query('update day_logs set done_count=$1, planned_count=$2, note=$3 where id=$4 and user_id=$5', [t.done, t.planned, note, same.id, uid]);
  } else {
    const dayNo = last ? last.day_no + 1 : 1;
    if (dayNo > 5) throw bad('5일 기록이 모두 찼어요.');
    if (last && last.d > t.d) throw bad('이미 지난 날짜 뒤로는 기록할 수 없어요.');
    await db.query(
      'insert into day_logs (user_id, day_no, log_date, done_count, planned_count, rule_version, note) values ($1,$2,$3::date,$4,$5,$6,$7)',
      [uid, dayNo, t.d, t.done, t.planned, ex.rule_version, note]);
  }
  return getExperiment(db, uid);
}

// 계획 규칙 변경: 1·2일차 기록이 있고 3일차 기록은 아직 없을 때만, 딱 한 번.
async function changeRule(db, uid, b) {
  const [ex] = await db.query('select * from experiments where user_id = $1', [uid]);
  if (!ex) throw bad('먼저 1일차 질문과 지표를 정하세요.');
  const logs = await db.query('select id, day_no from day_logs where user_id = $1 order by day_no', [uid]);
  if (logs.length !== 2) throw bad('계획 규칙은 2일차 기록을 남긴 뒤, 3일차 기록 전에만 바꿀 수 있어요.');
  const newRule = str(b.new_rule, '새 계획 규칙', { required: true, max: 200 });
  const newMax = int(b.new_max_per_day, '새 하루 최대 계획 수', { min: 1, max: 50, def: ex.max_per_day });
  const reason = str(b.reason, '바꾼 이유', { required: true, max: 300 });
  const rows = await db.query(
    `insert into rule_changes (user_id, old_rule, new_rule, old_max, new_max, reason, day1_log_id, day2_log_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (user_id) do nothing returning id`,
    [uid, ex.plan_rule, newRule, ex.max_per_day, newMax, reason, logs[0].id, logs[1].id]);
  if (!rows.length) throw new HttpError(409, '계획 규칙은 한 번만 바꿀 수 있어요.');
  await db.query('update experiments set plan_rule=$2, max_per_day=$3, rule_version=2 where user_id=$1', [uid, newRule, newMax]);
  return getExperiment(db, uid);
}

// ---------- 내보내기 ----------
// 내 계정의 자료만 담습니다. 비밀번호 해시·세션 값은 담지 않습니다.
async function exportAll(db, user) {
  const uid = user.id;
  const mine = (sql) => db.query(sql, [uid]);
  const ids = '(select id from tasks where user_id = $1)';
  return {
    format: 'pds-export-v3',
    exported_at: new Date().toISOString(),
    timezone: 'Asia/Seoul (날짜는 서울 기준, 시각은 UTC ISO 8601)',
    units: { time: '분(minute)' },
    account: { id: user.id, username: user.username },
    tasks: await mine('select * from tasks where user_id = $1 order by id'),
    task_revisions: await mine('select * from task_revisions where task_id in ' + ids + ' order by id'),
    completions: await mine('select * from completions where task_id in ' + ids + ' order by id'),
    runs: await mine('select * from runs where task_id in ' + ids + ' order by id'),
    reviews: await mine('select * from reviews where user_id = $1 order by id'),
    observation: await getExperiment(db, uid),
  };
}

// ---------- 가입·로그인 ----------
const LOGIN_FAIL = '아이디 또는 비밀번호가 올바르지 않습니다.'; // 아이디가 없을 때와 비밀번호가 틀릴 때 똑같은 문구

function toHttp(e) { return e instanceof auth.AuthError ? new HttpError(e.status, e.message) : e; }

async function signup(db, b) {
  let username, password;
  try { username = auth.checkUsername(b.username); password = auth.checkPassword(b.password); } catch (e) { throw toHttp(e); }
  const hash = await auth.hashPassword(password);
  const rows = await db.query(
    'insert into users (username, password_hash) values ($1, $2) on conflict do nothing returning id', [username, hash]);
  if (!rows.length) throw new HttpError(409, '이미 사용 중인 아이디입니다.');
  return { user: { id: rows[0].id, username }, token: await auth.createSession(db, rows[0].id) };
}

async function login(db, b) {
  const username = String(b.username ?? '').trim().toLowerCase().slice(0, 60);
  const password = String(b.password ?? '').slice(0, 200);
  const [u] = await db.query('select id, username, password_hash from users where lower(username) = $1', [username]);
  if (!u) { await auth.dummyVerify(password); throw new HttpError(401, LOGIN_FAIL); }
  if (!(await auth.verifyPassword(password, u.password_hash))) throw new HttpError(401, LOGIN_FAIL);
  return { user: { id: u.id, username: u.username }, token: await auth.createSession(db, u.id) };
}

// 비밀번호를 바꾸면 이 계정의 모든 세션을 지우고, 지금 쓰는 기기에만 새 세션을 줍니다.
async function changePassword(db, user, b) {
  const [u] = await db.query('select password_hash from users where id = $1', [user.id]);
  if (!(await auth.verifyPassword(String(b.old_password ?? '').slice(0, 200), u.password_hash))) throw new HttpError(401, '현재 비밀번호가 올바르지 않습니다.');
  let np;
  try { np = auth.checkPassword(b.new_password); } catch (e) { throw toHttp(e); }
  await db.query('update users set password_hash = $2 where id = $1', [user.id, await auth.hashPassword(np)]);
  await db.query('delete from sessions where user_id = $1', [user.id]);
  return { changed: true, token: await auth.createSession(db, user.id) };
}

// 계정 삭제: 내 계획·기록·돌아보기·5일 기록이 함께 지워집니다 (표의 on delete cascade).
async function deleteAccount(db, user, b) {
  const [u] = await db.query('select password_hash from users where id = $1', [user.id]);
  if (!(await auth.verifyPassword(String(b.password ?? '').slice(0, 200), u.password_hash))) throw new HttpError(401, '비밀번호가 올바르지 않습니다.');
  await db.query('delete from users where id = $1', [user.id]);
  return { deleted: true };
}

// ---------- 길 찾기 ----------
// 반환값에 __cookie(새 세션 값) 또는 __clear(쿠키 지우기)가 있으면 입출력 부분이 쿠키를 설정합니다.
async function route(db, method, parts, q, body, user, req) {
  const [a, b, c] = parts;
  if (a === 'health') return { ok: true, db: db.kind };
  if (a === 'auth') {
    if (b === 'signup' && method === 'POST') { const r = await signup(db, body); return { user: r.user, __cookie: r.token }; }
    if (b === 'login' && method === 'POST') { const r = await login(db, body); return { user: r.user, __cookie: r.token }; }
    if (b === 'logout' && method === 'POST') {
      const t = auth.readCookie(req);
      if (t) await db.query('delete from sessions where token_hash = $1', [auth.sha256(t)]); // 서버에서 세션을 지움
      return { ok: true, __clear: true };
    }
    if (b === 'me' && method === 'GET') return { user: user ? { id: user.id, username: user.username } : null };
    if (!user) throw new HttpError(401, '로그인이 필요합니다.');
    if (b === 'password' && method === 'POST') { const r = await changePassword(db, user, body); return { changed: true, __cookie: r.token }; }
    if (b === 'account' && method === 'DELETE') { await deleteAccount(db, user, body); return { deleted: true, __clear: true }; }
  }
  if (!user) throw new HttpError(401, '로그인이 필요합니다.');
  const uid = user.id;
  if (a === 'today') {
    const [r] = await db.query(`select ${TODAY_SEOUL}::text as today`);
    return r;
  }
  if (a === 'tasks') {
    if (!b && method === 'GET') return listTasks(db, uid, q);
    if (!b && method === 'POST') return getTask(db, uid, await insertTask(db, uid, taskInput(body)));
    if (b && !c && method === 'GET') return getTask(db, uid, idParam(b));
    if (b && !c && method === 'PUT') { await updateTask(db, uid, idParam(b), body); return getTask(db, uid, idParam(b)); }
    if (b && !c && method === 'DELETE') {
      const rows = await db.query(
        'update tasks set deleted_at = now() where id = $1 and user_id = $2 and deleted_at is null returning id', [idParam(b), uid]);
      if (!rows.length) throw new HttpError(404, '계획(할 일)을 찾을 수 없습니다.');
      return { deleted: true };
    }
    if (b && c === 'complete' && method === 'POST') return completeTask(db, uid, idParam(b), body);
    if (b && c === 'reopen' && method === 'POST') return reopenTask(db, uid, idParam(b));
    if (b && c === 'runs' && method === 'POST') return addRun(db, uid, idParam(b), body);
  }
  if (a === 'review' && !b && method === 'GET') return computeReview(db, uid, q);
  if (a === 'review' && b === 'carry' && method === 'POST') return carryOver(db, uid, body);
  if (a === 'reviews' && method === 'GET') return listReviews(db, uid);
  if (a === 'experiment' && !b && method === 'GET') return getExperiment(db, uid);
  if (a === 'experiment' && !b && method === 'POST') return createExperiment(db, uid, body);
  if (a === 'experiment' && b === 'day' && method === 'POST') return closeDay(db, uid, body);
  if (a === 'experiment' && b === 'rule-change' && method === 'POST') return changeRule(db, uid, body);
  if (a === 'export' && method === 'GET') return { __download: await exportAll(db, user) };
  throw new HttpError(404, '없는 주소입니다.');
}

// ---------- 입출력 ----------
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const ch of req) {
    size += ch.length;
    if (size > 100000) throw bad('요청이 너무 큽니다.');
    chunks.push(ch);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function send(res, status, data, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const q = Object.fromEntries(url.searchParams);
    let body = {};
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      try { body = await readBody(req); } catch (e) {
        if (e instanceof HttpError) throw e;
        throw bad('요청 내용을 읽을 수 없습니다.');
      }
    }
    // 다른 사이트에서 몰래 보낸 쓰기 요청 막기: Origin이 있으면 우리 주소와 같아야 합니다.
    if (req.method !== 'GET' && req.headers.origin) {
      let same = false;
      try { same = new URL(req.headers.origin).host === req.headers.host; } catch { /* 형식 오류는 거절 */ }
      if (!same) throw new HttpError(403, '허용되지 않은 출처의 요청입니다.');
    }
    const db = await getDb();
    const user = await auth.currentUser(db, req); // 쿠키의 세션 값 → 서버 DB에서 확인
    const result = await route(db, req.method, parts, q, body, user, req);
    if (result && (result.__cookie || result.__clear)) {
      const headers = { 'Set-Cookie': auth.cookieHeader(req, result.__cookie || '') };
      const { __cookie, __clear, ...data } = result;
      return send(res, 200, data, headers);
    }
    if (result && result.__download) {
      return send(res, 200, result.__download, {
        'Content-Disposition': 'attachment; filename="plan-do-see-export.json"',
      });
    }
    send(res, 200, result);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error('서버 오류:', e && e.code, e && e.message);
    send(res, 500, { error: '서버에서 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.' });
  }
};

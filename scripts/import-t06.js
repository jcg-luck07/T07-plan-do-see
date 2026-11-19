// 6번에서 내려받은 내보내기 파일(JSON)을 내 계정으로 가져옵니다. 6번 DB에는 접속하지 않습니다.
// 사용: npm run import-t06 -- 내아이디 "파일경로.json"
// 비어 있는 계정에만 가져옵니다 (두 번 가져와 중복되는 것을 막기 위해).
const fs = require('fs');
const { getDb } = require('../lib/db');

const d10 = (v) => (v ? String(v).slice(0, 10) : null); // '2026-11-17T00:00:00.000Z' → '2026-11-17'

(async () => {
  const username = String(process.argv[2] || '').trim().toLowerCase();
  const file = process.argv[3];
  if (!username || !file) { console.error('사용법: npm run import-t06 -- 내아이디 "파일경로.json"'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.tasks)) { console.error('내보내기 파일 모양이 아니에요 (tasks 없음).'); process.exit(1); }

  const db = await getDb();
  const [u] = await db.query('select id from users where lower(username) = $1', [username]);
  if (!u) { console.error('그 아이디의 계정이 없어요. 먼저 사이트에서 가입하세요.'); process.exit(1); }
  const [have] = await db.query('select count(*)::int as n from tasks where user_id = $1', [u.id]);
  if (have.n > 0) { console.error('이 계정에는 이미 계획이 있어요. 중복을 막으려고 가져오지 않아요.'); process.exit(1); }

  const taskMap = new Map();
  const reviewMap = new Map();
  try {
    for (const r of data.reviews || []) {
      const [x] = await db.query(
        'insert into reviews (user_id, period_from, period_to, snapshot, lesson, created_at) values ($1, $2::date, $3::date, $4::jsonb, $5, $6) returning id',
        [u.id, d10(r.period_from), d10(r.period_to), JSON.stringify(r.snapshot), r.lesson, r.created_at]);
      reviewMap.set(r.id, x.id);
    }
    for (const t of data.tasks) {
      const [x] = await db.query(
        `insert into tasks (user_id, title, start_date, due_date, priority, tags, success_criteria, estimated_minutes, status, done_at,
           carried_lesson, carried_from_review_id, deleted_at, created_at, updated_at)
         values ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
        [u.id, t.title, d10(t.start_date), d10(t.due_date), t.priority, t.tags || '', t.success_criteria || '', t.estimated_minutes || 0,
          t.status, t.done_at, t.carried_lesson, t.carried_from_review_id ? reviewMap.get(t.carried_from_review_id) ?? null : null,
          t.deleted_at, t.created_at, t.updated_at || t.created_at]);
      taskMap.set(t.id, x.id);
    }
    for (const r of data.reviews || []) {
      if (r.next_task_id && taskMap.has(r.next_task_id)) {
        await db.query('update reviews set next_task_id = $1 where id = $2', [taskMap.get(r.next_task_id), reviewMap.get(r.id)]);
      }
    }
    for (const v of data.task_revisions || []) {
      if (!taskMap.has(v.task_id)) continue;
      await db.query(
        `insert into task_revisions (task_id, version, title, start_date, due_date, priority, tags, success_criteria, estimated_minutes, change_note, changed_at)
         values ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11)`,
        [taskMap.get(v.task_id), v.version, v.title, d10(v.start_date), d10(v.due_date), v.priority, v.tags || '', v.success_criteria || '',
          v.estimated_minutes, v.change_note || '', v.changed_at]);
    }
    for (const c of data.completions || []) {
      if (!taskMap.has(c.task_id)) continue;
      await db.query('insert into completions (task_id, idempotency_key, completed_at, reverted_at) values ($1,$2,$3,$4)',
        [taskMap.get(c.task_id), 't06-' + c.idempotency_key, c.completed_at, c.reverted_at]);
    }
    for (const r of data.runs || []) {
      if (!taskMap.has(r.task_id)) continue;
      await db.query(
        'insert into runs (task_id, started_at, ended_at, actual_minutes, blocked_reason, idempotency_key, created_at) values ($1,$2,$3,$4,$5,$6,$7)',
        [taskMap.get(r.task_id), r.started_at, r.ended_at, r.actual_minutes, r.blocked_reason || '', r.idempotency_key ? 't06-' + r.idempotency_key : null, r.created_at]);
    }
  } catch (e) {
    // 중간에 실패하면 이 계정에 넣던 것을 모두 되돌려 다시 시도할 수 있게 함
    await db.query('delete from tasks where user_id = $1', [u.id]);
    await db.query('delete from reviews where user_id = $1', [u.id]);
    console.error('가져오기 실패, 되돌렸어요:', e.code || e.message);
    process.exit(2);
  }
  console.log(`가져옴: 계획 ${taskMap.size}개, 돌아보기 ${reviewMap.size}개, 수정이력 ${(data.task_revisions || []).length}개, 완료 ${(data.completions || []).length}개, 실행기록 ${(data.runs || []).length}개 → 계정 ${username}`);
  process.exit(0);
})().catch((e) => { console.error('실패:', e.code || e.message); process.exit(2); });

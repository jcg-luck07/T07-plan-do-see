// 6번에서 만든 주인 없는 자료(user_id가 비어 있는 계획·돌아보기)를 내 계정으로 옮깁니다.
// 사용: npm run claim -- 내아이디     (.env.local 의 DATABASE_URL 로 진짜 DB에 연결)
const { getDb } = require('../lib/db');

(async () => {
  const username = String(process.argv[2] || '').trim().toLowerCase();
  if (!username) { console.error('사용법: npm run claim -- 내아이디'); process.exit(1); }
  const db = await getDb();
  const [u] = await db.query('select id from users where lower(username) = $1', [username]);
  if (!u) { console.error('그 아이디의 계정이 없어요. 먼저 사이트에서 가입하세요.'); process.exit(1); }
  const t = await db.query('update tasks set user_id = $1 where user_id is null returning id', [u.id]);
  const r = await db.query('update reviews set user_id = $1 where user_id is null returning id', [u.id]);
  console.log(`옮긴 계획 ${t.length}개, 돌아보기 ${r.length}개 → 계정 ${username}`);
  process.exit(0);
})().catch((e) => { console.error('실패:', e.code || e.message); process.exit(2); });

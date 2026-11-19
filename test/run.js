// 자동 검사: 과제 통과 기준(T06-C04~C36)을 서버에 직접 확인합니다.
// 임시 폴더의 시험용 DB만 사용하므로 내 진짜 자료에는 영향이 없습니다.
const os = require('os');
const fs = require('fs');
const path = require('path');

delete process.env.DATABASE_URL; // 시험은 항상 임시 DB로
process.env.LOCAL_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pds-test-'));
const server = require('../server');

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log(`${cond ? '통과' : '실패'}  ${name}`); };

async function main() {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/api/`;
  // 쿠키 보관함: 계정마다 하나씩 (브라우저가 하는 일을 흉내 냄)
  const mkClient = () => {
    const jar = { cookie: '' };
    const raw = async (p, method = 'GET', body, extraHeaders = {}) => {
      const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar.cookie ? { Cookie: jar.cookie } : {}), ...extraHeaders };
      const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      const sc = res.headers.get('set-cookie');
      if (sc) jar.cookie = sc.startsWith('sid=;') ? '' : sc.split(';')[0];
      return { status: res.status, data: await res.json(), setCookie: sc };
    };
    return { jar, call: raw };
  };
  const clientA = mkClient();
  const call = clientA.call;
  const PW = 'test-pw-' + Math.random().toString(36).slice(2, 10);
  const su = await call('auth/signup', 'POST', { username: 'tester_a', password: PW, password_confirm: PW });
  ok(su.status === 200, 'T07 가입 후 바로 로그인 상태가 된다');

  // ---- 카드 1+2: 계획(할 일) — 계획과 할 일은 같은 것 ----
  const T = {};
  const mk = async (k, body) => { T[k] = (await call('tasks', 'POST', body)).data; };
  await mk('a', { title: '알파 <script>alert(1)</script>', start_date: '2019-12-01', due_date: '2020-01-01', priority: 1, tags: 'Study, 코딩', success_criteria: '카드 5개 완료', estimated_minutes: 60 });
  await mk('b', { title: '베타', due_date: '2099-01-01', priority: 2, tags: 'gym', estimated_minutes: 30 });
  await mk('c', { title: '감마', due_date: '2099-01-01', priority: 3, tags: 'study', estimated_minutes: 90 });
  await mk('d', { title: '델타', priority: 1, tags: '', estimated_minutes: 20 });
  await mk('e', { title: '엡실론', due_date: '2020-02-02', priority: 2, tags: 'study', estimated_minutes: 45 });
  ok((await call('plans')).status === 404, '계획 표/주소가 따로 없다 (계획 = 할 일, 하나로 통합)');
  ok(T.a.start_date === '2019-12-01' && T.a.due_date === '2020-01-01', 'C04 계획에 기간(시작~마감)이 저장된다');
  ok(T.a.priority === 1, 'C05 계획에 우선순위가 저장된다');
  ok(T.a.success_criteria === '카드 5개 완료', 'C06 계획에 성공 기준이 저장된다');
  ok(T.a.estimated_minutes === 60, 'C07 계획에 예상 시간이 저장된다');
  ok(T.b.start_date === '2099-01-01', '시작일을 비우면 마감일과 같은 날로 저장된다');
  ok((await call('tasks', 'POST', { title: 'x', start_date: '2026-12-01', due_date: '2026-11-01' })).status === 400, '잘못된 기간(마감<시작)은 거절된다');
  ok(T.a.id > 0 && T.a.title.includes('<script>'), 'C09 계획(할 일)을 만들 수 있다 (스크립트 글자는 글자 그대로 저장)');
  const edited = (await call('tasks/' + T.a.id, 'PUT', { title: '알파2 <script>alert(1)</script>', start_date: '2019-12-01', due_date: '2020-01-01', priority: 1, tags: 'Study, 코딩', success_criteria: '카드 5개 + 점검', estimated_minutes: 90, change_note: '예상 시간 늘림' })).data;
  ok(edited.id === T.a.id && edited.title.startsWith('알파2') && edited.estimated_minutes === 90, 'C08 ID는 그대로, 현재 값은 바뀐다');
  ok(edited.revisions.length === 2 && edited.revisions[0].title.startsWith('알파 ') && edited.revisions[0].estimated_minutes === 60 && edited.revisions[0].success_criteria === '카드 5개 완료' && edited.revisions[0].start_date === '2019-12-01', 'C08 고치기 전 처음 계획이 이력에 그대로 남는다');
  ok(edited.revisions[1].change_note === '예상 시간 늘림' && edited.revisions[1].estimated_minutes === 90, '고친 값과 이유도 이력에 쌓인다');
  T.a = edited;
  const upd = (await call('tasks/' + T.b.id, 'PUT', { title: '베타(수정)', due_date: '2099-01-01', priority: 2, tags: 'gym', estimated_minutes: 35 })).data;
  ok(upd.title === '베타(수정)' && upd.estimated_minutes === 35, 'C10 할 일을 고칠 수 있다');
  ok(T.a.due_date === '2020-01-01', 'C14 마감일이 저장된다');
  ok(T.a.priority === 1, 'C15 우선순위가 저장된다');
  ok(T.a.tags === 'study,코딩', 'C16 태그가 저장된다 (소문자·쉼표 정리)');
  ok(T.a.estimated_minutes === 90, 'C17 예상 시간이 저장된다 (고친 뒤 현재 값)');
  const search = (await call('tasks?q=' + encodeURIComponent('감마'))).data;
  ok(search.length === 1 && search[0].id === T.c.id, 'C18 할 일을 검색할 수 있다');
  const byTag = (await call('tasks?tag=study')).data;
  ok(byTag.length === 3, 'C19 태그로 거를 수 있다');
  ok((await call('tasks?priority=1')).data.length === 2, 'C19 우선순위로 거를 수 있다');
  const byDue = (await call('tasks?sort=due')).data.map((t) => t.id);
  const expected = [T.a.id, T.e.id, T.b.id, T.c.id, T.d.id]; // 마감일 빠른 순, 같으면 ID, 없으면 맨 뒤
  ok(JSON.stringify(byDue) === JSON.stringify(expected), 'C20 마감일 순 정렬 (같으면 ID순, 마감일 없음은 맨 뒤)');
  const again = (await call('tasks?sort=due')).data.map((t) => t.id);
  ok(JSON.stringify(again) === JSON.stringify(byDue), 'C20 같은 요청은 항상 같은 순서');
  const byPrio = (await call('tasks?sort=priority')).data.map((t) => t.id);
  ok(JSON.stringify(byPrio) === JSON.stringify([T.a.id, T.d.id, T.b.id, T.e.id, T.c.id]), 'C20 우선순위 순 정렬 (같으면 ID순)');
  ok((await call('tasks?late=1')).data.length === 2, '지연 거르기: 마감이 지난 미완료 2개');

  // ---- 카드 3: 완료·기록 ----
  const key = 'same-click-' + Date.now();
  const [r1, r2] = await Promise.all([
    call(`tasks/${T.a.id}/complete`, 'POST', { idempotency_key: key }),
    call(`tasks/${T.a.id}/complete`, 'POST', { idempotency_key: key }),
  ]);
  const [r3, r4] = await Promise.all([
    call(`tasks/${T.e.id}/complete`, 'POST', { idempotency_key: 'k-1' }),
    call(`tasks/${T.e.id}/complete`, 'POST', { idempotency_key: 'k-2' }), // 키가 달라도 (버튼 연타)
  ]);
  const created1 = [r1, r2].filter((r) => r.data.created).length;
  const created2 = [r3, r4].filter((r) => r.data.created).length;
  ok(created1 === 1 && created2 === 1, 'C21 연달아 두 번 눌러도 완료 기록은 한 건만 생긴다 (같은 키·다른 키 모두)');
  const exp = (await call('export')).data;
  ok(exp.completions.filter((c) => c.task_id === T.a.id && !c.reverted_at).length === 1 && exp.completions.filter((c) => c.task_id === T.e.id && !c.reverted_at).length === 1, 'C21 DB에 완료 기록이 각각 1건');
  const rv = (await call('review')).data;
  ok(rv.done === 2, 'C22 돌아보기의 완료 수는 정확히 2 (두 번 누른 일 2개 → 각 1씩)');
  const reopened = (await call(`tasks/${T.e.id}/reopen`, 'POST', {})).data;
  ok(reopened.status === 'doing', 'C12 완료한 할 일을 진행 중으로 되돌릴 수 있다');
  ok((await call(`tasks/${T.e.id}/complete`, 'POST', { idempotency_key: 'k-3' })).data.created === true, '되돌린 뒤에는 다시 완료할 수 있다');
  ok((await call(`tasks/${T.e.id}/reopen`, 'POST', {})).data.status === 'doing', 'C11/C12 완료 ↔ 진행 중 오가기');

  const before = (await call('tasks/' + T.a.id)).data;
  const runBody = { started_at: '2026-11-10T09:00', ended_at: '2026-11-10T10:30', blocked_reason: '자료가 부족했다', idempotency_key: 'run-1' };
  const run = (await call(`tasks/${T.a.id}/runs`, 'POST', runBody)).data;
  const run2 = (await call(`tasks/${T.a.id}/runs`, 'POST', runBody)).data;
  const after = run2.task;
  ok(run.task.runs[0].started_at === '2026-11-10T00:00:00.000Z' || /2026-11-10T00:00/.test(JSON.stringify(run.task.runs[0].started_at)), 'C23 실행 기록에 시작 시각이 저장된다 (서울 09:00 = UTC 00:00)');
  ok(/2026-11-10T01:30/.test(JSON.stringify(run.task.runs[0].ended_at)), 'C24 실행 기록에 끝난 시각이 저장된다');
  ok(run.task.runs[0].actual_minutes === 90, 'C25 실제로 걸린 시간이 저장된다 (분)');
  ok(run.task.runs[0].blocked_reason === '자료가 부족했다', 'C26 막혔던 이유가 저장된다');
  ok(after.estimated_minutes === before.estimated_minutes && after.due_date === before.due_date && after.priority === before.priority && after.title === before.title, 'C27 기록을 저장해도 원래 계획 값은 덮어쓰이지 않는다');
  ok(after.runs.length === 1, '같은 기록 요청을 두 번 보내도 기록은 한 건');
  await call(`tasks/${T.b.id}/runs`, 'POST', { started_at: '2026-11-11T10:00', ended_at: '2026-11-11T10:45' });
  await call(`tasks/${T.c.id}/runs`, 'POST', { started_at: '2026-11-12T10:00', ended_at: '2026-11-12T12:00', actual_minutes: 100, blocked_reason: '   ' });

  // ---- 카드 4: 돌아보기 ----
  const rev = (await call('review')).data;
  const list = (await call('tasks')).data;
  ok(rev.planned === 5 && rev.planned === list.length, 'C28 계획 수 = 지우지 않은 할 일 수');
  ok(rev.done === list.filter((t) => t.status === 'done').length, 'C29 완료 수 = 완료 상태 할 일 수');
  ok(rev.late === 1 && rev.late === (await call('tasks?late=1')).data.length, 'C30 지연 수 = 미완료이고 마감이 오늘보다 앞선 수 (완료한 것은 안 셈)');
  ok(rev.blocked === 1, 'C31 막힘 수 = 막힌 이유가 적힌 할 일 수 (공백만 적은 건 제외)');
  const estSum = list.reduce((s, t) => s + t.estimated_minutes, 0);
  ok(rev.estimated_minutes === estSum && rev.actual_minutes === 90 + 45 + 100 && rev.diff_minutes === rev.actual_minutes - rev.estimated_minutes, 'C32 예상·실제·차이(실제−예상) 계산');
  const empty = (await call('review?from=1999-01-01&to=1999-01-02')).data;
  ok(empty.planned === 0 && empty.estimated_minutes === 0 && empty.actual_minutes === 0 && empty.diff_minutes === 0, 'C32 아무것도 없으면 전부 0');
  ok((await call('tasks?blocked=1')).data.map((t) => t.id).join() === String(T.a.id), 'C83 막힘 숫자를 눌러 간 목록 = 막힌 할 일 (근거 기록으로 이동 가능)');
  const carry = (await call('review/carry', 'POST', { lesson: '예상 시간을 1.5배로 잡는다', next_start_date: '2026-12-06', next_due_date: '2026-12-12', next_estimated_minutes: 300 })).data;
  const nextPlan = (await call('tasks/' + carry.next_task_id)).data;
  ok(nextPlan.carried_lesson === '예상 시간을 1.5배로 잡는다' && nextPlan.carried_from_review_id === carry.review_id && nextPlan.due_date === '2026-12-12' && nextPlan.revisions.length === 1, 'C33 고칠 점 한 건이 다음 계획(새 계획 한 줄)으로 넘어간다');
  ok((await call('reviews')).data[0].snapshot.planned === 5, '돌아보기 숫자가 DB에 저장된다');

  // ---- 삭제 ----
  await call('tasks/' + T.d.id, 'DELETE');
  ok((await call('tasks/' + T.d.id)).status === 404 && (await call('tasks')).data.length === 5, 'C13 할 일을 지울 수 있다 (목록·돌아보기에서 빠짐)');
  ok((await call('review')).data.planned === 5, 'C28 지운 할 일은 계획 수에서 빠진다');

  // ---- 카드 5: 저장·내보내기·안전 ----
  const exp2 = (await call('export')).data;
  ok(exp2.tasks.length === 6 && exp2.task_revisions.length >= 7 && exp2.runs.length === 3 && exp2.reviews.length === 1, 'C36 내보내기에 계획·할 일·기록·돌아보기가 전부 들어 있다');
  ok(exp2.tasks.find((t) => t.id === T.a.id).title.includes('<script>'), 'C57 스크립트 모양 글자가 글자 그대로 저장된다');
  ok(!/postgres(ql)?:\/\//i.test(JSON.stringify(exp2)), 'C58 응답에 DB 접속 주소가 없다');
  const html = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html), 'C57 화면 코드는 글을 HTML로 넣지 않는다 (textContent만 사용)');
  ok((await call('tasks', 'POST', { title: '', due_date: 'x' })).status === 400, '빈 값/잘못된 값은 400으로 거절');

  // ================= T07: 회원 인증·인가 =================
  const { getDb } = require('../lib/db');
  const db = await getDb();
  const clientB = mkClient();
  const callB = clientB.call;
  const anon = mkClient().call;
  const idOf = async (name) => (await db.query('select id from users where username = $1', [name]))[0].id;

  // 가입·로그인·로그아웃
  const suB = await callB('auth/signup', 'POST', { username: 'tester_b', password: PW, password_confirm: PW }); // 같은 비밀번호로 두 번째 계정
  ok(suB.status === 200, 'C94 새 계정을 만들 수 있다');
  ok((await callB('auth/me')).data.user.username === 'tester_b', 'C95 가입한 계정으로 로그인 상태가 확인된다');
  const dup = await anon('auth/signup', 'POST', { username: 'TESTER_A', password: PW, password_confirm: PW });
  ok(dup.status === 409, 'C98 같은 아이디(대소문자 달라도)로 두 번 가입되지 않는다');
  ok((await anon('auth/signup', 'POST', { username: 'ab', password: PW, password_confirm: PW })).status === 400, '너무 짧은 아이디는 거절');
  ok((await anon('auth/signup', 'POST', { username: 'shortpw_user', password: '1234', password_confirm: '1234' })).status === 400, '너무 짧은 비밀번호는 거절');
  const wrongPw = await anon('auth/login', 'POST', { username: 'tester_a', password: 'wrong-password' });
  const noUser = await anon('auth/login', 'POST', { username: 'nobody_here', password: 'wrong-password' });
  ok(wrongPw.status === 401 && noUser.status === 401 && wrongPw.data.error === noUser.data.error, 'C99 비밀번호가 틀렸을 때와 아이디가 없을 때 안내 문구·상태가 같다');
  const clientA2 = mkClient();
  const li = await clientA2.call('auth/login', 'POST', { username: 'tester_a', password: PW });
  ok(li.status === 200 && li.data.user.username === 'tester_a', 'C95 로그인할 수 있다');

  // 비밀번호 저장
  const rowsPw = await db.query('select username, password_hash from users order by id');
  const hashA = rowsPw.find((r) => r.username === 'tester_a').password_hash;
  const hashB = rowsPw.find((r) => r.username === 'tester_b').password_hash;
  ok(hashA.startsWith('scrypt$') && !hashA.includes(PW), 'C101/C103 비밀번호는 scrypt 해시로 저장되고 평문이 보이지 않는다');
  ok(hashA !== hashB, 'C104 같은 비밀번호로 만든 두 계정의 저장값이 다르다 (계정마다 솔트가 다름)');
  const everything = JSON.stringify([su.data, li.data, wrongPw.data, noUser.data, (await call('export')).data]);
  ok(!everything.includes(PW) && !everything.includes('password_hash'), 'C105/C106 응답 어디에도 비밀번호 원문·해시가 없다');

  // 세션
  ok(/HttpOnly/i.test(li.setCookie) && /SameSite=Strict/i.test(li.setCookie) && /Max-Age=604800/.test(li.setCookie), 'C111 세션 쿠키는 HttpOnly·SameSite=Strict이고 7일(604800초) 뒤 만료된다');
  ok(!JSON.stringify(li.data).includes(clientA2.jar.cookie.split('=')[1]), 'C112 세션 값은 응답 본문에 나오지 않고 쿠키로만 간다');
  const sessRows = await db.query('select token_hash, expires_at > now() as live from sessions');
  ok(sessRows.length >= 3 && sessRows.every((r) => r.live && r.token_hash.length === 64 && !clientA2.jar.cookie.includes(r.token_hash)), 'C111 서버에는 세션 값의 해시만 있고 만료 시각이 미래다');
  ok((await anon('tasks')).status === 401, 'C97/C124 로그인하지 않고 자료를 요청하면 401로 거절된다');
  const oldCookie = clientA2.jar.cookie;
  ok((await clientA2.call('tasks')).status === 200, 'C109 로그아웃 전: 같은 값으로 요청하면 200');
  const lo = await clientA2.call('auth/logout', 'POST', {});
  ok(lo.status === 200, 'C96 로그아웃할 수 있다');
  const replay = await anon('tasks', 'GET', undefined, { Cookie: oldCookie });
  ok(replay.status === 401, 'C109/C110 로그아웃 뒤 같은 세션 값으로 같은 요청을 하면 401로 거절된다');
  // 비밀번호 변경 → 이전 세션 무효
  const clientA3 = mkClient();
  await clientA3.call('auth/login', 'POST', { username: 'tester_a', password: PW });
  const cookieA3 = clientA3.jar.cookie;
  const NEWPW = PW + '-new';
  ok((await call('auth/password', 'POST', { old_password: 'wrong-password', new_password: NEWPW, new_password_confirm: NEWPW })).status === 401, '현재 비밀번호가 틀리면 바꿀 수 없다');
  ok((await call('auth/password', 'POST', { old_password: PW, new_password: NEWPW, new_password_confirm: NEWPW })).status === 200, '비밀번호를 바꿀 수 있다');
  ok((await anon('auth/signup', 'POST', { username: 'mismatch_user', password: PW, password_confirm: PW + 'x' })).status === 400, '가입할 때 두 비밀번호가 다르면 거절된다');
  ok((await anon('auth/signup', 'POST', { username: 'noconfirm_user', password: PW })).status === 400, '비밀번호 확인 칸이 없으면 가입이 거절된다');
  ok((await call('auth/password', 'POST', { old_password: NEWPW, new_password: NEWPW + 'z', new_password_confirm: NEWPW + 'y' })).status === 400, '비밀번호를 바꿀 때 두 새 비밀번호가 다르면 거절된다');
  ok((await anon('tasks', 'GET', undefined, { Cookie: cookieA3 })).status === 401, 'C114 비밀번호를 바꾸면 이전에 발급한 세션 값이 더는 통하지 않는다');
  ok((await call('tasks')).status === 200, '비밀번호를 바꾼 기기는 새 세션으로 계속 쓸 수 있다');
  ok((await anon('auth/login', 'POST', { username: 'tester_a', password: PW })).status === 401, '옛 비밀번호로는 로그인되지 않는다');
  // 만료된 세션
  await db.query("update sessions set expires_at = now() - interval '1 minute' where user_id = $1", [await idOf('tester_b')]);
  ok((await callB('tasks')).status === 401, 'C111 만료 시각이 지난 세션은 거절된다');
  await callB('auth/login', 'POST', { username: 'tester_b', password: PW });

  // 다른 계정 자료 접근 제어
  const bId = await idOf('tester_b');
  const aId = await idOf('tester_a');
  const bTask = (await callB('tasks', 'POST', { title: 'B의 비밀 계획', due_date: '2099-05-05', estimated_minutes: 10 })).data;
  const bTask2 = (await callB('tasks', 'POST', { title: 'B의 두 번째', due_date: '2099-05-06', estimated_minutes: 20 })).data;
  const countOf = async (uid) => (await db.query(
    `select (select count(*) from tasks where user_id = $1)::int as t,
            (select count(*) from runs where task_id in (select id from tasks where user_id = $1))::int as r,
            (select count(*) from task_revisions where task_id in (select id from tasks where user_id = $1))::int as v,
            (select count(*) from completions where task_id in (select id from tasks where user_id = $1))::int as c`, [uid]))[0];
  const bBefore = await countOf(bId);
  const aBefore = await countOf(aId);
  const bSnap = JSON.stringify((await callB('tasks/' + bTask.id)).data);
  const peek = await call('tasks/' + bTask.id);
  ok(peek.status === 404 && !JSON.stringify(peek.data).includes('비밀'), 'C117/C121 A가 B의 계획을 읽으면 404 (존재를 감춤)');
  ok((await call('tasks/' + bTask.id, 'PUT', { title: '해킹', due_date: '2099-05-05' })).status === 404, 'C118 A가 B의 계획을 고치면 404');
  ok((await call('tasks/' + bTask.id, 'DELETE')).status === 404, 'C119 A가 B의 계획을 지우면 404');
  ok((await call(`tasks/${bTask.id}/complete`, 'POST', { idempotency_key: 'k-hack-1' })).status === 404, 'A가 B의 계획을 완료 처리해도 404');
  ok((await call(`tasks/${bTask.id}/runs`, 'POST', { started_at: '2099-05-05T10:00', ended_at: '2099-05-05T11:00' })).status === 404, 'A가 B의 계획에 기록을 끼워 넣어도 404');
  ok((await call(`tasks/${bTask.id}/reopen`, 'POST', {})).status === 404, 'A가 B의 계획을 되돌려도 404');
  const aTask = (await call('tasks', 'POST', { title: 'A의 계획', due_date: '2099-06-06', estimated_minutes: 5 })).data;
  const aMid = await countOf(aId);
  const aSnap = JSON.stringify((await call('tasks/' + aTask.id)).data);
  ok((await callB('tasks/' + aTask.id)).status === 404, 'C120 반대 방향: B가 A의 계획을 읽으면 404');
  ok((await callB('tasks/' + aTask.id, 'PUT', { title: '해킹', due_date: '2099-06-06' })).status === 404, 'C120 B가 A의 계획을 고치면 404');
  ok((await callB('tasks/' + aTask.id, 'DELETE')).status === 404, 'C120 B가 A의 계획을 지우면 404');
  ok((await callB(`tasks/${aTask.id}/runs`, 'POST', { started_at: '2099-06-06T10:00', ended_at: '2099-06-06T11:00' })).status === 404, 'C120 B가 A의 계획에 기록을 끼워 넣어도 404');
  ok(JSON.stringify(bBefore) === JSON.stringify(await countOf(bId)) && JSON.stringify(aMid) === JSON.stringify(await countOf(aId)) && aBefore.t + 1 === aMid.t, 'C122 거절 앞뒤로 반대편 계정의 건수가 같고 새로 생긴 자료가 없다');
  ok(JSON.stringify((await callB('tasks/' + bTask.id)).data) === bSnap && JSON.stringify((await call('tasks/' + aTask.id)).data) === aSnap, 'C122 거절된 뒤에도 자료 내용이 그대로다');
  const spoof = await call('tasks?user_id=' + bId + '&owner=tester_b', 'GET', undefined, { 'X-User-Id': String(bId), 'X-Forwarded-User': 'tester_b' });
  ok(spoof.status === 200 && spoof.data.length > 0 && spoof.data.every((t) => t.title !== 'B의 비밀 계획' && t.title !== 'B의 두 번째'), 'C123 주소·헤더에 B를 적어 보내도 A의 자료만 돌아온다');
  const spoofPost = (await call('tasks', 'POST', { title: '본문에 남의 계정 적기', due_date: '2099-07-07', user_id: bId, owner: 'tester_b' })).data;
  ok((await db.query('select user_id from tasks where id = $1', [spoofPost.id]))[0].user_id === aId, 'C123 본문에 user_id를 적어 보내도 내 계정 것으로만 만들어진다');
  const listA = (await call('tasks')).data;
  const listB = (await callB('tasks')).data;
  ok(!listA.some((t) => [bTask.id, bTask2.id].includes(t.id)) && !listB.some((t) => t.id === aTask.id), 'C125 목록 응답에 다른 계정 자료가 하나도 없다');
  const revA = (await call('review')).data;
  const revB = (await callB('review')).data;
  ok(revA.planned === listA.length && revB.planned === listB.length, '돌아보기 숫자도 내 계정 자료만 센다');
  const expA = (await call('export')).data;
  ok(expA.tasks.every((t) => t.user_id === expA.account.id) && !JSON.stringify(expA).includes('B의 비밀'), '내보내기에도 내 계정 자료만 들어 있다');
  ok((await anon('export')).status === 401, '로그인 없이 내보내기를 요청하면 401');
  ok((await anon('tasks', 'POST', { title: 'x' })).status === 401 && (await anon('tasks/' + bTask.id, 'DELETE')).status === 401, '로그인 없이 만들기·지우기를 요청하면 401');
  const cross = await call('tasks', 'POST', { title: 'x', due_date: '2099-01-01' }, { Origin: 'https://evil.example' });
  ok(cross.status === 403, '다른 사이트(Origin)에서 온 쓰기 요청은 403으로 거절된다');
  const pageHtml = await (await fetch(`http://localhost:${server.address().port}/`)).text();
  ok(!pageHtml.includes('B의 비밀') && pageHtml.includes('<main id="app"'), 'C97 첫 화면 HTML에는 자료가 없고, 자료는 로그인 뒤 API로만 온다');

  // 5일 관찰: 질문·지표 고정, 하루 마감, 규칙 변경
  ok((await call('experiment/rule-change', 'POST', { new_rule: 'x', reason: 'x' })).status === 400, 'C09 1일차 질문을 정하기 전에는 규칙을 바꿀 수 없다');
  const ex0 = (await call('experiment', 'POST', { question: '하루에 계획을 몇 개 끝내나?', plan_rule: '하루(마감일 기준) 계획은 최대 3개', max_per_day: 3 })).data;
  ok(ex0.experiment.metric === '일별 계획 완료 개수' && ex0.experiment.unit === '개' && ex0.experiment.question.startsWith('하루에'), 'C04~C06 질문 한 문장·지표·단위가 고정된다');
  ok(['missing_rule', 'duplicate_rule', 'outlier_rule', 'rounding_rule', 'week_start'].every((k) => ex0.experiment[k]), 'C23~C27 결측·중복·이상값·반올림·주 시작 요일이 저장돼 있다');
  ok((await call('experiment', 'POST', { question: '다른 질문', plan_rule: 'x' })).status === 409, '한 번 정한 질문·지표는 다시 바꿀 수 없다 (409)');
  for (let i = 0; i < 3; i++) await call('tasks', 'POST', { title: '한도' + i, due_date: '2099-08-08' });
  const over = await call('tasks', 'POST', { title: '한도 초과', due_date: '2099-08-08' });
  ok(over.status === 400 && over.data.error.includes('3개'), '계획 규칙(하루 최대 3개)을 서버가 지킨다');
  const d1 = (await call('experiment/day', 'POST', { note: '1일차' })).data;
  ok(d1.logs.length === 1 && d1.logs[0].day_no === 1, '하루 마감으로 1일차 기록이 생긴다');
  const d1b = (await call('experiment/day', 'POST', { note: '같은 날 다시' })).data;
  ok(d1b.logs.length === 1 && d1b.logs[0].note === '같은 날 다시', 'C24 같은 날짜를 다시 마감해도 새 줄이 생기지 않고 덮어쓴다');
  ok((await call('experiment/rule-change', 'POST', { new_rule: 'x', reason: 'x' })).status === 400, 'C09 2일차 기록 전에는 규칙을 바꿀 수 없다');
  await db.query('insert into day_logs (user_id, day_no, log_date, done_count, planned_count, rule_version) values ($1, 2, current_date + 1, 3, 3, 1)', [aId]);
  const ch = (await call('experiment/rule-change', 'POST', { new_rule: '하루(마감일 기준) 계획은 최대 2개', new_max_per_day: 2, reason: '3개는 많아서 못 끝냄' })).data;
  ok(ch.rule_change && ch.rule_change.reason && ch.rule_change.changed_at, 'C10/C11 규칙을 바꾼 시각과 이유가 기록된다');
  ok(ch.rule_change.day1_log_id === ch.logs[0].id && ch.rule_change.day2_log_id === ch.logs[1].id, 'C12 규칙 변경 기록이 1일차·2일차 기록을 정확히 가리킨다');
  ok((await call('experiment/rule-change', 'POST', { new_rule: 'y', reason: 'y' })).status === 409, '규칙은 한 번만 바꿀 수 있다');
  await db.query('insert into day_logs (user_id, day_no, log_date, done_count, planned_count, rule_version) values ($1, 3, current_date + 2, 4, 2, 2)', [aId]);
  const exF = (await call('experiment')).data;
  const sm = exF.summary;
  const sumHand = exF.logs.reduce((a, l) => a + l.done_count, 0);
  ok(sm.before.days === 2 && sm.after.days === 1 && sm.metric === '일별 계획 완료 개수' && sm.unit === '개', 'C13~C15 변경 전후를 같은 지표·단위로 비교한다');
  ok(sm.total === sumHand && sm.days === 3, 'C132 화면 합계가 5일 기록을 손으로 더한 값과 같다');
  ok(sm.average === Math.floor((sumHand * 20 + 3) / 6) / 10, 'C26 평균은 소수 첫째 자리로 반올림(5는 올림)한다');

  // 계정 삭제
  ok((await callB('auth/account', 'DELETE', { password: 'wrong-password' })).status === 401, '비밀번호가 틀리면 계정을 지울 수 없다');
  ok((await callB('auth/account', 'DELETE', { password: PW })).status === 200, 'C134 계정을 지울 수 있다');
  const leftover = await db.query('select (select count(*) from tasks where user_id = $1)::int as t, (select count(*) from sessions where user_id = $1)::int as s', [bId]);
  ok(leftover[0].t === 0 && leftover[0].s === 0, 'C134 계정을 지우면 그 계정의 자료와 세션도 함께 지워진다');
  ok((await callB('tasks')).status === 401, '지운 계정의 세션은 더는 통하지 않는다');

  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`);
  server.close();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('검사 중 오류:', e); process.exit(2); });

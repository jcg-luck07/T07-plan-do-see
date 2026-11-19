// 인증 증거 수집: 배포된 사이트에 시험 계정 2개로 실제 요청을 보내고, 요청과 응답을 마크다운으로 남깁니다.
// 비밀번호·세션 값은 기록에 쓰지 않고 가려서(마스킹) 적습니다. 끝나면 시험 계정을 지웁니다.
// 사용: node --env-file=.env.local scripts/evidence.js [사이트주소] [출력파일]
//   (.env.local 의 DATABASE_URL 은 '저장된 해시·세션 만료' 확인에만 쓰고, 값은 어디에도 출력하지 않습니다)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'https://t07-plan-do-see.vercel.app').replace(/\/$/, '');
const OUT = process.argv[3] || path.join(__dirname, '..', '증거', '인증-요청응답-기록.md');
const rnd = () => crypto.randomBytes(9).toString('base64url');
const PW = 'Pw-' + rnd(); // 시험용 무작위 비밀번호 (기록에는 쓰지 않음)
const NEWPW = 'Pw-' + rnd();
const SUFFIX = crypto.randomBytes(3).toString('hex');
const UA = 'evid_a_' + SUFFIX, UB = 'evid_b_' + SUFFIX;

const lines = [];
const out = (s = '') => lines.push(s);
const mask = (v) => (v && v.length > 8 ? v.slice(0, 4) + '…생략' : '…생략');
const SECRET_KEYS = ['password', 'password_confirm', 'old_password', 'new_password', 'new_password_confirm'];
const maskBody = (b) => (b ? JSON.stringify(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, SECRET_KEYS.includes(k) ? '***' : v]))) : '');
const maskCookie = (c) => (c ? c.replace(/sid=([^;\s]+)/g, (_, v) => 'sid=' + mask(v)) : '');
const brief = (data) => {
  if (Array.isArray(data)) return JSON.stringify(data.map((t) => ({ id: t.id, title: t.title })));
  const s = JSON.stringify(data, (k, v) => (['password_hash', 'token', 'sid'].includes(k) ? '…생략' : v));
  return s.length > 300 ? s.slice(0, 300) + '…(이하 생략)' : s;
};

function client(label) {
  const c = { label, cookie: '' };
  c.call = async (method, p, body, o = {}) => {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    const cookie = o.cookie !== undefined ? o.cookie : c.cookie;
    if (cookie) headers.Cookie = cookie;
    Object.assign(headers, o.headers || {});
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    let data = null;
    try { data = await res.json(); } catch { /* 본문 없음 */ }
    if (sc && o.cookie === undefined) c.cookie = sc.startsWith('sid=;') ? '' : sc.split(';')[0];
    if (!o.quiet) {
      const hs = Object.entries(o.headers || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
      out('```');
      out(`> [${o.who || label}] ${method} ${p}${cookie ? '  Cookie: ' + maskCookie(cookie) : '  (쿠키 없음)'}${hs ? '  ' + hs : ''}${body ? '  본문: ' + maskBody(body) : ''}`);
      out(`< ${res.status} ${res.statusText || ''}  ${brief(data)}${sc ? '  Set-Cookie: ' + maskCookie(sc) : ''}`);
      out('```');
    }
    return { status: res.status, data, setCookie: sc, cookie };
  };
  return c;
}

const checks = [];
const check = (id, text, cond) => { checks.push([id, text, !!cond]); out(`- ${cond ? '✅' : '❌'} **${id}** ${text}`); };

(async () => {
  let db = null;
  try { if (process.env.DATABASE_URL) db = await require('../lib/db').getDb(); } catch { db = null; }
  const A = client('계정 A'), B = client('계정 B'), N = client('로그인 안 함');
  out('# 인증 요청·응답 기록');
  out();
  out(`- 대상 사이트: ${BASE}`);
  out(`- 실행 시각(UTC): ${new Date().toISOString()}`);
  out(`- 시험 계정: \`${UA}\`, \`${UB}\` (끝에서 지움). 비밀번호·세션 값은 **마스킹**했고 비밀번호 원문은 기록하지 않았습니다.`);
  out('- 표기: `>` 보낸 요청, `<` 받은 응답. `sid=Ab12…생략` 은 세션 쿠키 값의 앞 4글자만 보인 것입니다.');
  out();

  try {
    // ---------- 카드 1 ----------
    out('## 1. 가입·로그인·로그아웃');
    out();
    out('### 1-1 로그인 없이 자료 요청 / 첫 화면');
    const n1 = await N.call('GET', '/api/tasks');
    const html = await (await fetch(BASE + '/')).text();
    check('C97', `로그인 없이 자료 요청은 ${n1.status}로 거절되고, 첫 화면 HTML에는 로그인 화면(id="login")만 있고 자료가 없다`, n1.status === 401 && html.includes('id="login"'));
    out();
    out('### 1-2 가입 / 로그인 / 같은 아이디 두 번 가입 / 틀린 비밀번호 vs 없는 아이디');
    const s1 = await A.call('POST', '/api/auth/signup', { username: UA, password: PW, password_confirm: PW });
    const s2 = await B.call('POST', '/api/auth/signup', { username: UB, password: PW, password_confirm: PW });
    check('C94', '새 계정 2개를 만들 수 있다 (같은 비밀번호로 가입)', s1.status === 200 && s2.status === 200);
    const dup = await N.call('POST', '/api/auth/signup', { username: UA.toUpperCase(), password: PW, password_confirm: PW });
    check('C98', '같은 아이디(대소문자만 다르게)로 두 번 가입하면 거절된다', dup.status === 409);
    const mm = await N.call('POST', '/api/auth/signup', { username: 'evid_mm_' + SUFFIX, password: PW, password_confirm: PW + 'x' });
    check('가입 확인칸', '비밀번호 두 칸이 다르면 가입이 거절된다', mm.status === 400);
    const wrong = await N.call('POST', '/api/auth/login', { username: UA, password: 'wrong-password' });
    const nouser = await N.call('POST', '/api/auth/login', { username: 'nobody_' + SUFFIX, password: 'wrong-password' });
    check('C99', '비밀번호만 틀렸을 때와 아이디가 없을 때의 상태·안내 문구가 같다', wrong.status === nouser.status && JSON.stringify(wrong.data) === JSON.stringify(nouser.data));
    const A2 = client('계정 A(다른 기기)');
    const l1 = await A2.call('POST', '/api/auth/login', { username: UA, password: PW });
    check('C95', '만든 계정으로 로그인할 수 있다', l1.status === 200);
    out();

    // ---------- 카드 2 ----------
    out('## 2. 비밀번호 저장 방식');
    out();
    out('- 방법: **scrypt** (Node 내장 `crypto.scrypt`, N=16384, r=8, p=1, 64바이트), 계정마다 무작위 솔트 16바이트.');
    if (db) {
      const rows = await db.query('select username, password_hash from users where username = any($1) order by id', [[UA, UB]]);
      const ha = rows.find((r) => r.username === UA).password_hash, hb = rows.find((r) => r.username === UB).password_hash;
      out('- 같은 비밀번호로 만든 두 시험 계정이 데이터베이스(`users.password_hash`)에 저장된 모습 (시험 계정이며 끝에서 지움):');
      out('```');
      out(`${UA}: ${ha}`);
      out(`${UB}: ${hb}`);
      out('```');
      check('C103', '저장된 값에 입력한 글자가 그대로 보이지 않는다 (형식 scrypt$N$r$p$솔트$해시)', ha.startsWith('scrypt$') && !ha.includes(PW));
      check('C104', '같은 비밀번호로 만든 두 계정의 저장값이 서로 다르다', ha !== hb);
    } else {
      out('- (DATABASE_URL 이 없어 DB 직접 조회는 건너뜀)');
    }
    const allText = lines.join('\n');
    check('C105/C106', '위의 모든 요청·응답 기록에 비밀번호 원문이 없다', !allText.includes(PW));
    out();

    // ---------- 카드 3 ----------
    out('## 3. 세션으로 인증 상태 유지 (로그아웃 전후 비교)');
    out();
    out('- 방식: **서버 세션**. 로그인하면 서버가 무작위 32바이트 값을 만들어 `HttpOnly; SameSite=Strict` 쿠키로 주고, 서버 DB에는 그 값의 SHA-256 해시와 만료 시각만 저장합니다. 값은 주소(URL)에 들어가지 않습니다.');
    out();
    const staleCookie = A2.cookie;
    out('### 3-1 같은 주소·같은 방식(GET /api/tasks)으로, 로그아웃 전과 후');
    const before = await A2.call('GET', '/api/tasks', null, { who: '로그아웃 전' });
    const lo = await A2.call('POST', '/api/auth/logout', {}, { who: '로그아웃' });
    const after = await N.call('GET', '/api/tasks', null, { cookie: staleCookie, who: '로그아웃 후, 같은 쿠키 값으로' });
    check('C109/C110', `같은 요청이 로그아웃 전 ${before.status}, 로그아웃 후 ${after.status}. 달라진 것은 로그아웃 여부뿐이다`, before.status === 200 && lo.status === 200 && after.status === 401);
    check('C112', '세션 값은 응답 본문·주소에 나오지 않고 쿠키로만 간다', !JSON.stringify(l1.data).includes(staleCookie.split('=')[1]));
    check('C111', '쿠키 Max-Age=604800 (7일) 이다', /Max-Age=604800/.test(l1.setCookie || '') && /HttpOnly/i.test(l1.setCookie) && /SameSite=Strict/i.test(l1.setCookie));
    if (db) {
      const sess = await db.query(
        `select left(s.token_hash, 8) as hash8, s.created_at, s.expires_at, (s.expires_at - s.created_at) as span
         from sessions s join users u on u.id = s.user_id where u.username = $1 order by s.created_at desc limit 1`, [UA]);
      out('- 서버에 저장된 A의 세션 한 줄 (값 자체가 아니라 해시 앞 8글자만):');
      out('```');
      out(JSON.stringify(sess[0]));
      out('```');
    }
    out();
    out('### 3-2 비밀번호를 바꾸면 이전에 발급한 세션이 무효가 된다');
    const oldA = client('계정 A(옛 세션)');
    await oldA.call('POST', '/api/auth/login', { username: UA, password: PW }, { quiet: true });
    const stale2 = oldA.cookie;
    const pre = await N.call('GET', '/api/tasks', null, { cookie: stale2, who: '비밀번호 변경 전, 옛 세션' });
    const chg = await A.call('POST', '/api/auth/password', { old_password: PW, new_password: NEWPW, new_password_confirm: NEWPW });
    const post = await N.call('GET', '/api/tasks', null, { cookie: stale2, who: '비밀번호 변경 후, 같은 옛 세션' });
    check('C114', `비밀번호를 바꾸면 이전 세션이 통하지 않는다 (전 ${pre.status} → 후 ${post.status})`, pre.status === 200 && chg.status === 200 && post.status === 401);
    out();
    out('### 3-3 비밀키');
    out('- 이 방식은 서명용 비밀키를 쓰지 않습니다(세션 값은 무작위값이고 서버 DB 조회로 확인). 비밀값은 DB 접속 주소(`DATABASE_URL`) 하나이고 서버 환경변수에만 있습니다.');
    out();

    // ---------- 카드 4 ----------
    out('## 4. 다른 계정 자료 접근 제어');
    out();
    const mk = async (c, title, due) => (await c.call('POST', '/api/tasks', { title, due_date: due, estimated_minutes: 10 }, { quiet: true })).data;
    const aT = [await mk(A, '증거용 A 계획 1', '2099-01-01'), await mk(A, '증거용 A 계획 2', '2099-01-02')];
    const bT = [await mk(B, '증거용 B 계획 1', '2099-02-01'), await mk(B, '증거용 B 계획 2', '2099-02-02')];
    out(`- 두 계정에 자료를 넣었습니다: A의 계획 id ${aT.map((t) => t.id)}, B의 계획 id ${bT.map((t) => t.id)}. (비밀번호는 적지 않음)`);
    check('C116', '계정 두 개를 만들어 각각에 자료를 넣었다', aT.every((t) => t.id) && bT.every((t) => t.id));
    out();
    const count = async (c) => (await c.call('GET', '/api/tasks', null, { quiet: true })).data.length;
    const aN0 = await count(A), bN0 = await count(B);
    out(`- 시도 전 건수: A ${aN0}건, B ${bN0}건`);
    out();
    out('### 4-1 A → B 자료 (읽기·수정·삭제)');
    const r1 = await A.call('GET', '/api/tasks/' + bT[0].id);
    const r2 = await A.call('PUT', '/api/tasks/' + bT[0].id, { title: '해킹 시도', due_date: '2099-02-01' });
    const r3 = await A.call('DELETE', '/api/tasks/' + bT[0].id);
    check('C117', `A가 B의 계획을 읽으면 ${r1.status}`, r1.status === 404);
    check('C118', `A가 B의 계획을 고치면 ${r2.status}`, r2.status === 404);
    check('C119', `A가 B의 계획을 지우면 ${r3.status}`, r3.status === 404);
    out();
    out('### 4-2 반대 방향 B → A 자료');
    const q1 = await B.call('GET', '/api/tasks/' + aT[0].id);
    const q2 = await B.call('PUT', '/api/tasks/' + aT[0].id, { title: '해킹 시도', due_date: '2099-01-01' });
    const q3 = await B.call('DELETE', '/api/tasks/' + aT[0].id);
    check('C120', `B → A 읽기·수정·삭제가 모두 거절된다 (${q1.status}/${q2.status}/${q3.status})`, [q1, q2, q3].every((r) => r.status === 404));
    check('C121', '거절은 존재 자체를 감추는 404이다 (403이 아니라 "없는 자료"와 같은 응답)', [r1, r2, r3, q1, q2, q3].every((r) => r.status === 404));
    out();
    out('### 4-3 거절 앞뒤로 반대편 자료 건수와 내용');
    const aN1 = await count(A), bN1 = await count(B);
    const bOne = (await B.call('GET', '/api/tasks/' + bT[0].id, null, { quiet: true })).data;
    out(`- 시도 후 건수: A ${aN1}건, B ${bN1}건 (시도 전 A ${aN0}, B ${bN0})`);
    check('C122', '거절 앞뒤로 반대편 계정의 건수가 같고 새로 생긴 자료가 없다. 내용도 그대로다', aN0 === aN1 && bN0 === bN1 && bOne.title === '증거용 B 계획 1');
    out();
    out('### 4-4 주소·헤더·본문에 다른 계정을 적어 보내기');
    const bUserId = bT[0].id; // 번호는 단서일 뿐, 서버는 쿠키의 세션으로만 주인을 정한다
    const sp1 = await A.call('GET', `/api/tasks?user_id=${bUserId}&owner=${UB}`, null, { headers: { 'X-User-Id': String(bUserId), 'X-Forwarded-User': UB } });
    check('C123a', '주소(?user_id=…&owner=B)·헤더(X-User-Id)에 B를 적어도 A의 자료만 돌아온다', sp1.status === 200 && sp1.data.every((t) => t.title.includes('A 계획')));
    const sp2 = await A.call('POST', '/api/tasks', { title: '본문에 B 적기', due_date: '2099-03-03', user_id: 1, owner: UB });
    const bN2 = await count(B);
    check('C123b', '본문에 user_id·owner를 적어 보내도 내 계정 자료로만 만들어지고 B의 건수는 그대로다', sp2.status === 200 && bN2 === bN0);
    out();
    out('### 4-5 로그인 없이 직접 요청');
    const u1 = await N.call('GET', '/api/tasks/' + bT[0].id);
    const u2 = await N.call('DELETE', '/api/tasks/' + bT[0].id);
    const u3 = await N.call('GET', '/api/export');
    check('C124', `로그인 없이 읽기·지우기·내보내기를 요청하면 모두 401 (${u1.status}/${u2.status}/${u3.status})`, [u1, u2, u3].every((r) => r.status === 401));
    out();
    out('### 4-6 목록 응답에 다른 계정 자료가 없다');
    const la = await A.call('GET', '/api/tasks');
    const lb = await B.call('GET', '/api/tasks');
    const bIds = new Set(bT.map((t) => t.id)), aIds = new Set(aT.map((t) => t.id));
    check('C125', 'A의 목록에 B의 계획이 하나도 없고, B의 목록에도 A의 계획이 없다', la.data.every((t) => !bIds.has(t.id)) && lb.data.every((t) => !aIds.has(t.id)));
    out();
    out('### 4-7 위 거절을 만드는 소스 위치');
    out('- `lib/handler.js` — `route()`: 로그인한 사용자(`user`)가 없으면 401. 있으면 모든 조회·쓰기에 `user.id`를 넘깁니다.');
    out('- `lib/handler.js` — `getTask()`, `updateTask()`, 삭제(`route()` 안 DELETE), `completeTask()`, `reopenTask()`, `addRun()`: SQL의 `where id = $1 and user_id = $2` 조건. 남의 자료는 "없음"으로 보여 404.');
    out('- `lib/handler.js` — `taskFilterSql()`: 목록·돌아보기가 모두 거치는 곳이며 `t.user_id = $1` 조건을 항상 붙입니다.');
    out('- 주소·헤더·본문의 계정 값은 읽지 않습니다. 주인은 오직 쿠키 세션(`lib/auth.js` `currentUser()`)으로 정합니다.');
    out();

    // ---------- 카드 5 ----------
    out('## 5. 내보내기와 계정 삭제');
    out();
    const ex = await A.call('GET', '/api/export', null, { quiet: true });
    out(`- A의 내보내기: ${ex.status}, 계획 ${ex.data.tasks.length}건, 모두 A의 계정 번호(${ex.data.account.id})의 것, \`password_hash\` 없음`);
    check('C133', '내 자료 전체를 파일 하나로 내보낼 수 있고 내 계정 자료만 들어 있다', ex.status === 200 && ex.data.tasks.every((t) => t.user_id === ex.data.account.id) && !JSON.stringify(ex.data).includes('password_hash'));
    out();
    out('### 5-1 계정 삭제 (시험 계정 정리)');
    const dBad = await B.call('DELETE', '/api/auth/account', { password: 'wrong-password' });
    const dA = await A.call('DELETE', '/api/auth/account', { password: NEWPW });
    const dB = await B.call('DELETE', '/api/auth/account', { password: PW });
    const gone = await N.call('GET', '/api/tasks', null, { cookie: B.cookie || 'sid=gone', who: '지운 뒤' });
    let left = '확인 안 함';
    if (db) {
      const r = await db.query('select count(*)::int as n from tasks where user_id in (select id from users where username = any($1))', [[UA, UB]]);
      const u = await db.query('select count(*)::int as n from users where username = any($1)', [[UA, UB]]);
      left = `남은 계정 ${u[0].n}개, 남은 계획 ${r[0].n}건`;
      out(`- 삭제 뒤 DB 확인: ${left}`);
    }
    check('C134', '비밀번호가 틀리면 삭제 불가, 맞으면 계정과 자료가 함께 지워진다', dBad.status === 401 && dA.status === 200 && dB.status === 200 && (!db || left.startsWith('남은 계정 0개, 남은 계획 0건')));
    void gone;
  } catch (e) {
    out();
    out('> 실행 중 오류: ' + (e.code || e.message));
    // 정리 시도
    for (const [c, pw] of [[A, NEWPW], [A, PW], [B, PW]]) { try { await c.call('DELETE', '/api/auth/account', { password: pw }, { quiet: true }); } catch { /* 무시 */ } }
  }

  out();
  out('## 확인 결과 요약');
  out();
  out('| 항목 | 결과 |');
  out('|---|---|');
  for (const [id, text, okk] of checks) out(`| ${id} ${text.replace(/\|/g, '/')} | ${okk ? '통과' : '실패'} |`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  const failed = checks.filter((c) => !c[2]).length;
  console.log(`기록 저장: ${OUT}\n통과 ${checks.length - failed} / 실패 ${failed}`);
  process.exit(failed ? 1 : 0);
})();

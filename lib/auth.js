// 회원 인증: 직접 구현. 비밀번호는 Node 내장 scrypt, 로그인 상태는 서버 DB의 세션으로 유지합니다.
// 비밀키(서명용 비밀값)는 쓰지 않습니다. 세션 값은 무작위 32바이트이고, 서버에는 그 SHA-256 해시만 저장합니다.
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const SESSION_DAYS = 7;
const COOKIE = 'sid';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- 비밀번호 ----
async function hashPassword(password) {
  const salt = crypto.randomBytes(16); // 계정마다 다른 솔트 → 같은 비밀번호도 저장값이 달라짐
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}

// 없는 아이디로 로그인해도 같은 시간이 걸리도록 쓰는 가짜 해시 (아이디 존재 여부를 응답 시간으로 알아내지 못하게)
let dummy = null;
async function dummyVerify(password) {
  if (!dummy) dummy = await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummy);
}

// ---- 입력 검사 ----
function checkUsername(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{4,30}$/.test(s)) throw new AuthError(400, '아이디는 영문 소문자·숫자·_ . - 로 4~30자여야 합니다.');
  return s;
}
function checkPassword(v) {
  const s = String(v ?? '');
  if (s.length < 8 || s.length > 128) throw new AuthError(400, '비밀번호는 8~128자여야 합니다.');
  return s;
}

// ---- 세션 ----
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)`,
    [sha256(token), userId, String(SESSION_DAYS)]);
  return token;
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

// 요청 쿠키의 세션이 살아 있으면 { id, username } 을, 아니면 null 을 돌려줍니다.
async function currentUser(db, req) {
  const token = readCookie(req);
  if (!token || token.length > 100) return null;
  const rows = await db.query(
    `select u.id, u.username from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`, [sha256(token)]);
  return rows[0] || null;
}

function cookieHeader(req, token) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const base = `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${secure}`;
  return token ? `${base}; Max-Age=${SESSION_DAYS * 86400}` : `${base}; Max-Age=0`;
}

module.exports = {
  AuthError, hashPassword, verifyPassword, dummyVerify, checkUsername, checkPassword,
  createSession, currentUser, readCookie, cookieHeader, sha256, SESSION_DAYS,
};

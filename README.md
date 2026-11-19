# 플랜두씨 다이어리 (T06-plan-do-see)

계획(Plan) → 했나 안 했나(Do) → 돌아보기(See)를 서버 데이터베이스로 잇는 개인 다이어리. (과제 6)
계획과 할 일은 같은 것입니다. 달력에 적은 한 줄이 곧 계획이고, 달력 표에서 Do 칸은 실제로 한 일의 기록, See 칸은 달성/미달성 확인입니다.

> 로그인한 계정의 자료만 보입니다. 다른 계정의 자료는 서버가 막습니다.

## 구성
- `public/` 화면 (HTML·CSS·JS, 프레임워크 없음)
- `api/index.js`, `lib/handler.js` 서버 API (Vercel 서버 함수)
- `lib/schema.js` DB 표 정의, `contracts/pds-schema-v2.json` 데이터 약속(표·항목·관계·날짜 규칙)
- `test/run.js` 자동 검사 (과제 통과 기준 C04~C36 확인)

## 내 컴퓨터에서 해 보기
```bash
npm install
npm run dev     # http://localhost:3000  (DATABASE_URL이 없으면 내 컴퓨터 안의 시험용 DB 사용)
npm test        # 자동 검사
```

## 진짜 서버 DB(Supabase)에 연결하기
1. `.env.example`을 참고해 `.env.local` 파일을 만들고 `DATABASE_URL=` 에 Supabase 연결 주소를 넣습니다. (이 파일은 Git에 올라가지 않습니다.)
2. 같은 값을 Vercel → Project → Settings → Environment Variables 에도 `DATABASE_URL` 이름으로 넣습니다.
3. 서버가 처음 켜질 때 표가 자동으로 만들어집니다. 모든 표에는 행 단위 보안(RLS)이 켜집니다.

## 안전
- 비밀값은 `DATABASE_URL` 하나이고 서버 환경변수로만 읽습니다. 브라우저 코드에는 없습니다.
- 사용자가 적은 글은 `textContent`로만 화면에 넣어 스크립트 모양 글자도 글자 그대로 보입니다. (CSP도 설정)

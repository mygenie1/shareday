# 셰어데이 배포 가이드 (Vercel + Neon + 공공데이터포털)

이 문서는 지시서 STEP 2·6의 **대시보드/외부 신청 작업**을 사람이 직접 수행하는 절차입니다.
코드는 이미 모두 구현돼 있으니, 아래 연결·환경변수·스키마만 마치면 배포됩니다.

## 0. 로컬에서 먼저 확인

```bash
npm install
cp .env.example .env.local      # 값 채우기 (DATABASE_URL, DATA_GO_KR_KEY)
npm run dev                     # http://localhost:3000
```

`.env.local` 없이도 캘린더 UI와 IndexedDB(개인 일정)는 동작합니다.
공유/공휴일 기능만 DB·서비스키가 있어야 붙습니다.

## 1. GitHub 저장소에 올리기

```bash
git init
git add .
git commit -m "셰어데이: Next.js 앱 + 공유/코멘트/공휴일 백엔드"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

> `.gitignore`가 `.env*`, `node_modules`, 원본 `셰어데이 캘린더.html`을 제외합니다. 비밀키는 절대 커밋되지 않습니다.

## 2. Vercel Import

1. [vercel.com](https://vercel.com) → **Add New → Project** → 위 저장소 import.
2. 프레임워크는 **Next.js**로 자동 감지됩니다. 그대로 Deploy.

## 3. Neon Postgres 연결 (STEP 2)

1. Vercel 프로젝트 → **Storage → Create Database → Neon (Marketplace)**.
2. **Free** 플랜 선택 (scale-to-zero, idle 시 비용 없음).
3. 연결하면 `DATABASE_URL`(및 관련 변수)이 프로젝트 환경변수로 **자동 주입**됩니다.
4. Neon 콘솔 → **SQL Editor**에서 [`db/schema.sql`](./db/schema.sql) 전체를 붙여넣고 실행 → 테이블 3개 생성.

## 4. 공휴일 서비스키 (STEP 6)

1. [data.go.kr](https://www.data.go.kr) 로그인 → **"한국천문연구원_특일 정보"** 검색 → **활용신청**.
2. 마이페이지 → **개발계정** → **서비스키(디코딩된 일반 인증키)** 확인.
   - 하루 트래픽 10,000회(개발). 우리는 연 1~2회만 호출하고 캐시합니다.
3. Vercel 프로젝트 → **Settings → Environment Variables**에 추가:
   - `DATA_GO_KR_KEY` = 발급받은 **디코딩(Decoding)** 키
   - (선택) `NEXT_PUBLIC_BASE_URL` = 커스텀 도메인 (예: `https://shareday.app`). 없으면 요청 host로 링크를 만듭니다.
4. **Redeploy** 하여 환경변수를 반영.

> 서비스키는 서버 함수(`/api/holidays`)에서만 쓰이고 응답에 포함되지 않으므로 프론트에 노출되지 않습니다.

## 5. 동작 확인

- `/` : 캘린더. 일정 추가 → 새로고침해도 유지되면 IndexedDB OK.
- 공휴일: 달력의 빨간 날 표시 → `/api/holidays?year=2026` 응답 확인.
- 공유: **공유** 버튼 → 링크 생성 → 링크 열기(로그인 없이 열람).
- 프라이빗 토글 → 이미 만든 링크에서도 즉시 숨겨지는지 확인.
- 코멘트: 받는 사람 페이지에서 작성 → 목록에 반영.

## 6. 최종 체크리스트 (지시서 STEP 7)

- [x] `DATABASE_URL`, `DATA_GO_KR_KEY`는 Vercel 환경변수에만 (코드/깃 제외 — `.gitignore` 확인)
- [x] 공유 API가 `isPrivate` 일정을 **서버에서 재차 필터링** (`lib/share.ts` `sanitizeEvents`)
- [x] 토큰은 192-bit 랜덤 (`lib/share.ts` `genToken`, 순번 아님)
- [x] 만료·폐기 조건이 조회 시 적용 (`lib/share.ts` `isLive`, GET → 410)
- [x] 받는 사람 페이지 `/s/[token]`가 로그인 없이 열림
- [x] 공휴일 서비스키가 프론트에 노출되지 않음 (서버 함수 경유)
- [x] 개인 일정이 서버로 전송되지 않음 (IndexedDB에만; 공유 시 공개분만 업로드)

## 참고: 공휴일 캐시 갱신

특일 정보 API는 대략 앞으로 1년치만 노출합니다. 연말에 다음 해를 한 번 조회하면
`holidays` 테이블에 캐시됩니다(자동). 강제 갱신이 필요하면 해당 연도 행을 삭제 후 다시 조회하세요:

```sql
delete from holidays where date >= '2027-01-01' and date <= '2027-12-31';
```

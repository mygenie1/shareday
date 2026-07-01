# 셰어데이 (Shareday)

친구·가족과 나누는 일정 공유 캘린더. **개인 일정은 내 기기(IndexedDB)에만** 저장되고,
**공개로 표시한 일정만** 추측 불가한 링크로 공유됩니다. 받는 사람은 로그인 없이 열람하고 코멘트를 남길 수 있어요.

## 아키텍처

```
app/
  page.tsx                    캘린더 UI 마운트 (Claude Design 산출물 + /calendar.js)
  layout.tsx                  루트 레이아웃 (Pretendard 폰트)
  globals.css                 캘린더 스타일 (원본 <style>에서 추출)
  calendar-markup.ts          캘린더 body 마크업 (문자열)
  s/[token]/                  받는 사람용 공개 페이지 (로그인 불필요)
    page.tsx  Recipient.tsx  recipient.css
  api/
    share/route.ts                    POST  공개 스냅샷 생성
    share/[token]/route.ts            GET/PUT/DELETE  조회·동기화·폐기
    share/[token]/comments/route.ts   GET/POST  코멘트
    holidays/route.ts                 GET  공휴일(서버 캐시)
public/calendar.js            캘린더 로직 (IndexedDB · 공유 API · 공휴일 연동)
lib/
  db.ts          Neon serverless 클라이언트
  share.ts       토큰 생성·서버측 isPrivate 필터·유효성
  rateLimit.ts   간단한 IP 기반 레이트 리밋
db/schema.sql    Postgres 스키마 (share_links, comments, holidays)
```

### 데이터 경계 (핵심 설계)

| 데이터 | 위치 | 서버 전송 |
|---|---|---|
| 개인 일정 · 카테고리 | 브라우저 IndexedDB | ❌ 절대 안 함 |
| 공개 일정 스냅샷 | `share_links.events` | ✅ 공개분만, 서버에서 재필터 |
| 코멘트 | `comments` | ✅ |
| 공휴일 캐시 | `holidays` | 서버만 (서비스키 비노출) |

## 개발

```bash
npm install
cp .env.example .env.local     # DATABASE_URL, DATA_GO_KR_KEY
npm run dev
```

DB/키 없이도 캘린더와 개인 일정(IndexedDB)은 동작합니다. 공유·공휴일만 백엔드가 필요합니다.

## 배포

[Vercel + Neon + 공공데이터포털] 절차는 [`DEPLOY.md`](./DEPLOY.md) 참고.

## API 요약

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/share` | 공개 스냅샷 생성 → `{token, url}` |
| GET | `/api/share/[token]` | 스냅샷 조회 (만료·폐기 시 410) |
| PUT | `/api/share/[token]` | 스냅샷 갱신 (한 링크, 실시간 반영) |
| DELETE | `/api/share/[token]` | 링크 폐기 |
| GET | `/api/share/[token]/comments?eventId=` | 코멘트 목록 |
| POST | `/api/share/[token]/comments` | 코멘트 작성 (분당 5건 제한) |
| GET | `/api/holidays?year=YYYY` | 공휴일 (캐시 우선) |

> 지시서에는 POST/GET/DELETE만 있었지만, "한 링크가 실시간으로 갱신된다"는 제품 약속
> (프라이빗으로 내리면 공유 중인 링크에서도 숨겨짐)을 지키기 위해 **PUT**을 추가했습니다.

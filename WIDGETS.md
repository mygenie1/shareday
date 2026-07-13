# 셰어데이 홈 화면 위젯 — 런북

웹앱은 그대로 두고, **Capacitor**로 네이티브 껍데기를 씌워 홈 화면 위젯을 붙인다.
앱 본체는 번들된 셸(`webDir = capacitor-www`, `npm run build:shell`로 생성)을 띄우므로 오프라인에도 열리고, 서버가 필요한 기능만 `https://shareday-seven.vercel.app`으로 호출한다(`middleware.ts`가 CORS 허용).

> **iOS와 안드로이드는 지금 설계가 다르다.** 같은 코드로 수렴시키기 전까지는 이 차이를 알고 봐야 한다.
>
> | | iOS | 안드로이드 |
> |---|---|---|
> | 위젯 데이터 | **App Group 로컬 스냅샷** (네트워크 없음) | 서버 공개 스냅샷 `GET /api/share/[token]` fetch |
> | 표시 대상 | **내 일정**(기본) ↔ 받은 친구 캘린더 | 공유 링크 토큰으로 고른 **공개** 캘린더 |
> | 프라이빗 | 앱 토글로 **포함 가능**(기본 꺼짐) | 절대 안 뜸(공개 스냅샷뿐) |
> | 위젯 종류 | 2종 — 이번 달 / 이번 주 | 1종 — 오늘 목록 |
> | 공유 저장소 키 | `shareday_widget_v2` | `shareday_widget` (레거시) |
> | 번들 ID | `com.mygenie.shareday` | `com.shareday.app` |
>
> 두 경로는 **서로 다른 키**를 쓰므로 섞이지 않는다. `WidgetBridgePlugin.java`는 JS가 넘기는 `group` 인자를 무시하고 항상 자기 `SharedPreferences("shareday_widget_prefs")`를 읽는다 — iOS의 App Group 상수를 바꿔도 안드로이드는 영향이 없다.

---

## iOS

### 데이터 흐름 — 위젯은 서버를 부르지 않는다
```
[앱] 일정 추가·수정·삭제(afterMutate) / 포그라운드 복귀 / 콜드 스타트
      │  pushWidgetIOS()  — public/calendar.js
      │    · 내 일정: expandRange()로 RRULE을 펼친 인스턴스
      │    · 친구 일정: 이미 캐시된 friendSnaps(공개 스냅샷)
      │    · 카테고리 색을 미리 박아 넣음(위젯은 조인 못 함)
      │    · 비공개 토글이 꺼져 있으면 여기서 제외 — 위젯에 넘기지 않는다
      ▼
[App Group] UserDefaults(group.com.mygenie.shareday) · key "shareday_widget_v2"
      │   { version:2, weekStart:0, includePrivate, selectedIndex,
      │     targets:[{kind:'mine'|'friend', name, token}],
      │     events:[{targetIndex, date, time, end, title, color, isPrivate}] }
      ▼
[위젯] loadSnapshot() → 렌더. WidgetBridge.reloadAllTimelines()로 즉시 갱신,
       그 외에는 자정에만 다시 그린다(네트워크가 없으니 주기 폴링할 이유가 없음).
```

**프라이버시**: 개인 일정은 서버로 가지 않는다. 위젯 payload는 기기 안 App Group에만 쓰인다. 비공개 일정은 토글이 꺼져 있으면 payload 단계에서 빠지므로, 위젯 쪽에서 걸러지는 게 아니라 **애초에 건네지지 않는다**.

### 위젯 2종
- **이번 달** (`systemMedium`/`systemLarge`) — 월 그리드, 일정 있는 날에 카테고리 색점.
- **이번 주** (`systemSmall`/`systemMedium`) — 이번 주(일요일 시작) 일정을 시간순 목록으로.

둘 다 `AppIntentConfiguration`이다.
- **길게눌러 설정** → 캘린더를 지정하면 그 위젯은 거기에 **고정**되고 ↻ 버튼이 숨는다.
- 비워 두면 앱의 선택(`selectedIndex`)을 따라가고, 위젯의 **↻ 버튼**이 그 선택을 순환시킨다.
- 탭 → `shareday://calendar` → 앱 열림.

### 식별자
- 앱 `com.mygenie.shareday` · 위젯 `com.mygenie.shareday.ShareDayWidget` · App Group `group.com.mygenie.shareday`
- 번들 ID는 **`scripts/ios-add-widget-target.rb`의 상수가 소유**한다. 바꾸려면 거기 한 줄을 고치고 스크립트를 재실행하면 앱·위젯 pbxproj가 함께 따라온다.
- URL scheme `shareday`는 번들 ID와 무관하게 유지.

### 파일이 어디 있나
| 파일 | 역할 |
|---|---|
| `native/ios/App/WidgetBridge.swift` / `.m` | Capacitor 플러그인 — `setItem`/`getItem`/`reloadAllTimelines`. `.m`의 `CAP_PLUGIN`이 자동 등록하므로 별도 코드 불필요 |
| `native/ios/ShareDayWidget/WidgetData.swift` | App Group I/O + 스냅샷 모델. **네트워크 코드 없음** |
| `native/ios/ShareDayWidget/ShareDayWidget.swift` | 위젯 2종 + `WidgetBundle` + ↻/설정 인텐트 |
| `native/ios/ShareDayWidget/Info.plist`, `*.entitlements` | 익스텐션 설정 · App Group |
| `public/calendar.js` (`pushWidgetIOS` 부근) | 스냅샷 작성 + 위젯 설정 시트 |

소스는 `native/ios/`에 그대로 두고 Xcode 프로젝트가 **참조**한다(복사본 없음). 고칠 때도 여기만 고친다.

### Xcode 타깃 (Mac 없이)
`npx cap add ios`는 App 타깃 하나만 만든다. 위젯 익스텐션은 Xcode 없이는 못 넣으므로 pbxproj를 스크립트로 기술한다:

```bash
gem install xcodeproj
ruby scripts/ios-add-widget-target.rb     # 멱등 — 두 번 돌려도 안전
```
스크립트가 하는 일: App 타깃에 WidgetBridge 소스 + App Group entitlement + 번들 ID, `ShareDayWidgetExtension` 타깃(iOS 17, 자체 entitlement) 생성, `.appex`를 PlugIns에 임베드, 앱→위젯 의존성, 위젯 버전을 앱과 동기화(App Store Connect가 일치를 요구).
결과 `project.pbxproj`는 **커밋**한다. Codemagic도 같은 스크립트를 안전망으로 재실행한다.

> 위젯 익스텐션은 **iOS 17+**. `AppIntentConfiguration`과 인터랙티브 버튼을 availability 분기 없이 쓰기 위해서다. 그 이하 기기에선 위젯만 안 보이고 앱은 정상 동작한다.

### 애플 콘솔에서 먼저 만들어 둘 것 (사람이 직접)
1. App Group `group.com.mygenie.shareday`
2. App ID `com.mygenie.shareday` — App Groups capability + 위 그룹
3. App ID `com.mygenie.shareday.ShareDayWidget` — App Groups + 같은 그룹
4. App Store distribution 프로비저닝 프로파일 **2개**(앱 + 위젯)

### Codemagic (`ios-testflight`)
`npm ci` → `build:shell`(커밋 해시를 `SHAREDAY_BUILD`로 스탬프) → `cap sync ios` → 위젯 타깃 스크립트 → `pod install` → **앱·위젯 프로파일을 각각** `fetch-signing-files` → `use-profiles` → `agvtool new-version -all $BUILD_NUMBER` → `build-ipa` → TestFlight.

빌드 마커는 앱 메뉴 맨 아래에 `build <해시>`로 작게 뜬다. 테스트 기기에서 **"이 빌드가 정말 최신 코드인가"** 를 확인하는 유일한 방법이다(웹에선 렌더되지 않는다).

---

## 안드로이드 (기존 설계 그대로)

`android/`는 이미 생성·통합·커밋됨 — Java 위젯 provider/worker/plugin, res, Manifest receiver+딥링크, `registerPlugin`, WorkManager. 웹이 바뀌면 `npx cap sync android`.

- 앱 메뉴 → **홈 위젯** → 공개 캘린더(공유 링크 토큰) 선택 → `SharedPreferences`에 기록 → 위젯이 `base + /api/share/{token}`을 fetch해 **오늘 공개 일정** 표시.
- 배터리를 생각해 fetch 주기는 ~30분. 앱에서 바꾸면 즉시 reload.
- **프라이빗 일정은 뜨지 않는다** — 공개 스냅샷만 읽으므로 구조적으로 불가능.
- 빠른 확인: Codemagic `android-debug` 워크플로 → Artifacts의 `app-debug.apk` 사이드로드.
- 배포: `android-internal` → Play 내부 테스트.

시크릿(저장소에 커밋 금지): `shareday_android` 그룹에 `CM_KEYSTORE`(base64 .jks), `CM_KEYSTORE_PASSWORD`, `CM_KEY_ALIAS`, `CM_KEY_PASSWORD`, `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS`. iOS는 `shareday_ios` 그룹 + ASC API 키 통합(`codemagic`).

---

## 실기기 확인 체크리스트 (TestFlight)
앱을 완전 삭제 후 재설치(캐시 회피).

- [ ] 메뉴 하단 빌드 마커가 최신 커밋 해시와 일치한다.
- [ ] 앱이 정상 기동(흰 화면 아님), 비행기 모드에서도 캘린더가 뜬다.
- [ ] 위젯 갤러리에 **셰어데이 2종**(이번 달 / 이번 주)이 보인다.
- [ ] 위젯에 **내 일정**이 보인다. ↻로 친구 캘린더로 전환된다. 길게눌러 설정으로도 지정된다.
- [ ] "비공개 일정 포함"이 꺼져 있으면 프라이빗 일정이 위젯에 **안 보이고**, 켜면 보인다.
- [ ] 일정을 추가·수정하면 위젯이 갱신된다(약간의 지연은 정상 — OS가 타임라인 리로드를 조절한다).
- [ ] 위젯 탭 → 앱이 열린다.
- [ ] 웹·안드로이드 기존 기능에 회귀가 없다.

## 정직한 한계
- 위젯 UI는 **플랫폼별 네이티브 2벌**(SwiftUI / RemoteViews). 한 코드로 안 된다.
- iOS 위젯 Swift는 이 저장소(Windows)에서 **컴파일 검증 불가**. 첫 Codemagic 빌드가 진짜 첫 컴파일이다 — 빨간불이 나면 로그를 보고 고친다.
- 위젯 갱신 시점은 최종적으로 **OS가 결정**한다. 앱이 `reloadAllTimelines()`를 불러도 즉시가 보장되진 않는다.
- iOS 위젯이 보여주는 친구 일정은 앱이 **마지막으로 캐시한** 공개 스냅샷이다(위젯이 직접 새로 받아오지 않는다). 앱을 열면 갱신된다.
- 네이티브는 스토어 심사가 있어 웹처럼 즉시 반영되지 않는다.

# 셰어데이 홈 화면 위젯 — 셋업 런북

기존 웹앱은 그대로 두고, **Capacitor**로 네이티브 껍데기를 만들어 **홈 화면 위젯**을 iOS·안드로이드에 붙인다.
위젯은 **서버의 공개 스냅샷(`GET /api/share/[token]`)만** 읽는다 — 프라이빗 일정은 위젯에 절대 안 뜬다(로컬 전용).

> 이 저장소에는 **웹 브리지(완성·검증됨)** + **네이티브 위젯/플러그인 소스(`native/`)** + **`codemagic.yaml`** 이 들어 있다.
> 아래 단계는 **Mac/Android Studio/Xcode/Codemagic**에서 수행한다(웹 저장소만으로는 네이티브 빌드가 안 됨).

---

## 데이터 흐름
```
[웹앱: 메뉴 → 홈 위젯]  사용자가 공개 캘린더 선택
      │  WidgetBridge.setItem({group, key:"shareday_widget", value: JSON})
      ▼
[공유 저장소] iOS: App Group UserDefaults(group.com.shareday.app)
             Android: SharedPreferences("shareday_widget_prefs")
      │  값: { tokens:[{token,name,kind}], selectedIndex, base }
      ▼
[위젯]  selectedIndex 토큰으로 base + /api/share/{token} fetch → 오늘 공개 일정 렌더
        (iOS 45분, Android ~30분 주기 · 앱에서 바꾸면 즉시 reload)
```
- 앱 식별자: **`com.shareday.app`**, App Group: **`group.com.shareday.app`**, 이름 "셰어데이".
- 앱 본체 로딩: `capacitor.config.ts`의 `server.url = https://shareday-seven.vercel.app`.

---

## STEP 0. 사전 준비 (한 번)
```bash
npm install                 # @capacitor/* 설치 (package.json에 추가돼 있음)
npx cap add ios             # ios/  프로젝트 생성 (Mac 필요)
npx cap add android         # android/ 프로젝트 생성
npx cap sync
```
> `ios/`·`android/`는 생성 후 **커밋**한다(Codemagic이 그대로 빌드). 이후엔 `npx cap sync`만.

---

## STEP 1. WidgetBridge 플러그인 (앱↔위젯 통신)

### iOS
1. `native/ios/App/WidgetBridge.swift`, `native/ios/App/WidgetBridge.m` 를 **App 타깃**(`ios/App/App/`)에 추가.
2. 별도 등록 코드는 불필요 — `.m`의 `CAP_PLUGIN` 매크로가 자동 등록한다.

### Android
1. `native/android/plugin/WidgetBridgePlugin.kt` 를 `android/app/src/main/java/com/shareday/app/` 에 복사.
2. `MainActivity.kt`(같은 패키지)에서 **등록**:
   ```kotlin
   import com.getcapacitor.BridgeActivity
   class MainActivity : BridgeActivity() {
     override fun onCreate(savedInstanceState: android.os.Bundle?) {
       registerPlugin(WidgetBridgePlugin::class.java)   // super.onCreate 전에
       super.onCreate(savedInstanceState)
     }
   }
   ```
3. `android/app/build.gradle`에 WorkManager 의존성:
   ```gradle
   dependencies { implementation "androidx.work:work-runtime-ktx:2.9.1" }
   ```

> JS 쪽(`public/calendar.js`)은 `window.Capacitor.Plugins.WidgetBridge` 를 자동으로 감지한다.
> 플러그인이 없으면(웹) 선택을 IndexedDB에만 저장하고 안내 문구를 띄운다 — 그대로 동작.

---

## STEP 2. iOS 위젯 (WidgetKit + SwiftUI)
1. Xcode: **File → New → Target → Widget Extension** (이름 `ShareDayWidget`, "Include Configuration Intent" 체크 해제).
2. 생성된 위젯 타깃에서 기본 파일을 지우고 `native/ios/ShareDayWidget/WidgetData.swift`, `ShareDayWidget.swift` 추가.
3. **App Group** 설정: App 타깃과 위젯 타깃 **둘 다** Signing & Capabilities → App Groups → `group.com.shareday.app` 추가.
4. **딥링크**: App 타깃 Info에 URL Scheme `shareday` 등록(위젯 탭 → `shareday://calendar` → 앱 열림).
5. 서명: 두 타깃 모두 팀 선택(Codemagic 자동 서명이면 프로비저닝만 맞추면 됨).
6. iOS 17+ 이면 위젯의 ↻ 버튼으로 캘린더 전환(AppIntent). 16 이하는 탭 시 앱 열림으로 폴백.

## STEP 3. 안드로이드 위젯 (App Widget + RemoteViews)
1. 아래를 `android/app/src/main/` 아래 대응 위치로 복사:
   - `native/android/widget/ShareDayWidgetProvider.kt`, `WidgetFetchWorker.kt` → `java/com/shareday/app/`
   - `res/layout/shareday_widget.xml` → `res/layout/`
   - `res/drawable/widget_dot.xml`, `widget_bg.xml` → `res/drawable/`
   - `res/xml/shareday_widget_info.xml` → `res/xml/`
2. `AndroidManifest.additions.xml` 의 내용을 `AndroidManifest.xml`에 병합(리시버는 `<application>` 안, 딥링크 intent-filter는 MainActivity `<activity>` 안, INTERNET 권한).
3. 빌드 후 홈 화면 → 위젯 추가 → "셰어데이".

---

## STEP 4. Codemagic 빌드/배포
1. Codemagic에 저장소 연결. `codemagic.yaml` 자동 인식.
2. 시크릿(그룹) 설정 — **저장소에 커밋 금지**:
   - `shareday_android`: `CM_KEYSTORE`(base64 .jks), `CM_KEYSTORE_PASSWORD`, `CM_KEY_ALIAS`, `CM_KEY_PASSWORD`, `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS`.
   - `shareday_ios`: App Store Connect API 키 통합(`shareday_asc_key`), 배포/위젯 프로비저닝.
3. `android-internal` → Play **내부 테스트**, `ios-testflight` → **TestFlight** 로 먼저 배포해 실기기에서 위젯 확인.

---

## 검증 체크리스트
- [ ] 앱 본체가 기존 웹앱 그대로 뜬다(웹뷰, server.url).
- [ ] 앱 메뉴 → **홈 위젯** → 공개 캘린더 선택 → 저장 → 공유 저장소에 기록.
- [ ] iOS/안드 위젯이 홈에서 **오늘 공개 일정**을 표시.
- [ ] 위젯 ↻(iOS17+/안드) 로 내 공개/친구 캘린더 **전환**.
- [ ] 위젯 탭 → 앱 열림(`shareday://calendar`).
- [ ] 만료/폐기 링크(410/404) → "링크가 만료됐어요", 네트워크 실패 → 조용히 마지막 렌더.
- [ ] **프라이빗 일정은 위젯에 안 뜸**(공개 스냅샷만).

---

## 정직한 한계 · 주의
- 위젯 UI는 **플랫폼별 네이티브 2벌**(SwiftUI / RemoteViews). 한 코드로 자동 생성 안 됨.
- `native/`의 Swift/Kotlin/XML은 **리뷰로 검증**된 스캐폴드다 — 이 저장소(웹)에서 컴파일/실행 검증은 불가. Xcode/Studio에서 임포트·iOS 버전 가드·리소스 경로를 최종 확인해야 한다.
- 서버 fetch 주기는 배터리 고려 30분~1h(더 자주 금지). OS가 갱신 주기를 조절할 수 있다.
- 권장 순서: **안드로이드 위젯 먼저** 완성해 흐름 검증 → iOS.
- 네이티브 빌드·스토어 심사가 따르므로 웹처럼 즉시 반영이 아니다.
- 계정 도입 전까지 위젯은 **공유 링크 토큰 기반 공개 데이터**만. 프라이빗은 향후 계정+동기화 시 확장.

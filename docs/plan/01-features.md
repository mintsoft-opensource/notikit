# 기능 카탈로그

> 우선순위: `MVP` 필수 · `MVP+` 조기확장 · `후순위` 검증 후
> (← [README](README.md) · 아키텍처는 [03-server-architecture.md](03-server-architecture.md))
>
> ⚠️ **이 문서는 로드맵이다.** 우선순위 태그(MVP/MVP+/후순위)는 목표이며, 실제 구현 여부는 아래 **구현 상태 요약**을 기준으로 한다.

## 구현 상태 요약 (2026-09 기준)

**✅ 구현됨**
- 디바이스: 업서트·멀티디바이스·메타(locale/timezone/country)·무효토큰 자동정리(전송응답 unregistered)
- Identity: `identify`·유저 속성·`identity_hash`(HMAC) 검증
- 메시징: 개인(single)/토픽/세그먼트/broadcast 발송, 예약발송(`scheduled_at`), 딥링크, A/B **변형 분배**, 카카오 폴백 플래그
- 억제리스트(opt-out) · In-app 인박스(조회/읽음) · Quiet hours(프로젝트 UTC 시간)
- 세그먼트(속성 **동등 매칭**) · 저니(명시적 enroll + send/wait 스텝) · 카카오 알림톡 폴백
- 웹훅(HMAC 서명 + 원자적 재시도, 자체 구현) · 분석(디바이스 활동/DAU·발송 집계) · rate limit
- 멀티테넌시(Org→Project, env 분리, 프로젝트별 Firebase 격리·AES-GCM 암호화)
- SDK: core/web/react/react-native/flutter/android(Kotlin)/swift · MCP(5 tools) · OpenAPI 문서 · **log-only 모드**

**🔜 미구현(계획)**
- 익명→식별 병합, 선호센터, 템플릿 변수치환(스키마만), Rich push(이미지/버튼)·silent/data·우선순위·TTL·다국어 콘텐츠
- A/B **승자 자동선택**, 전달추적(delivered/opened/clicked/dismissed)·읽은 유저 목록
- WAU/MAU·GeoIP 지역분석·토픽 증감·퍼널·코호트·CSV export
- 빈도제한(fatigue)·발송시간 최적화(유저 타임존)·이벤트 트리거 푸시·In-app 메시지(배너/모달)·액션 버튼
- realtime(Centrifugo)·친구톡·멀티채널 워터폴·미리보기·발송승인·마이그레이션 임포트·화이트라벨·RBAC·감사로그
- idempotency·DLQ·OS 네이티브(채널/뱃지/그룹/사운드)·llms.txt·OpenAPI→SDK 자동생성·AI 카피·GDPR export/삭제·리텐션

## A. 디바이스 라이프사이클
- 토큰 관리·업서트 · **멀티디바이스**(유저=여러 기기) `MVP`
- 메타: OS/앱버전·기종·**locale·timezone·region** `MVP`
- 토큰 로테이션·로그인/로그아웃 재매핑 · last-active · 채널(android/ios/web/webview/electron) `MVP`
- **무효 토큰 자동정리**(전송응답 unregistered) `MVP`
- **앱 삭제/이탈 감지** `MVP+` — ⚠️ "silent로 실시간"이 아니라 **전송응답 기반 무효화 + 이탈률 지표**로 설계

## B. 유저 / Identity ⭐(핵심 차별점)
- **identify**(외부 유저ID 매핑) · **유저 속성/태그** `MVP`
- 익명→식별 **병합**(로그인 시) `MVP+`
- **알림 선호센터**(토픽/카테고리 opt-in) `MVP+`

## C. 메시징
- **개인/세그먼트/토픽 발송** `MVP` (개인발송 = identity 핵심 활용)
- 템플릿 + **변수치환**(`{{name}}` 등) `MVP` — ⚠️ **토픽 브로드캐스트는 개인화 불가**(수신자별 개별 렌더링 필요)
- **Rich push**(이미지·버튼·딥링크) · silent/data · 우선순위 · TTL/collapse `MVP`
- **딥링크** `MVP` — payload `deep_link` + 네이티브 Universal/App Links (OneLink 불필요; 푸시는 이미 설치된 유저)
- 예약 발송(타임존) `MVP+` · A/B(서버사이드, 승자선택) `MVP+` · 반복 캠페인 `후순위`
- 다국어 콘텐츠(로케일별) `MVP+`

## D. 전달 추적
- sent/delivered/**opened(읽음)**/clicked/dismissed `MVP`
- **메시지·토픽별 읽은 유저 목록** · 유저별 전달상태 `MVP`
- 실패 사유 · **전환추적**(open→이벤트) `MVP+`

## E. 분석
- **DAU/WAU/MAU** · **지역 분석**(GeoIP/locale) · **토픽 구독자 수/증감** `MVP`
- 오픈/클릭률 · **전달 퍼널** · 이탈률 · 코호트 · 히트맵 · CSV export `MVP+`

## F. 타게팅
- **세그먼트**(속성+행동+지역 규칙) `MVP+`
- **Quiet hours / 빈도 제한**(fatigue) · 지역 타게팅 · **발송시간 최적화**(유저 타임존) `MVP+`

## G. 자동화 / 참여
- **이벤트 트리거 푸시**(event→push) `MVP+`
- 저니/워크플로(다단계) `후순위`
- **In-app 인박스**(수신 이력) · **In-app 메시지**(배너/모달) `MVP+`
- **알림 액션 버튼**(답장/수락 등) `MVP+`

## H. 채널
- push(FCM) · **Web Push(VAPID/FCM)** · **WebView**(네이티브 브리지) `MVP`
- realtime(Centrifugo/Soketi — webview/electron/web 상시연결) `MVP+`
- **카카오 알림톡/친구톡 폴백** ⭐(국내 킬러) `MVP+`
- 멀티채널 워터폴(push→카카오→SMS→email) · APNs 다이렉트 · HMS `후순위`

## I. 운영 편의
- **테스트 발송**(내 폰 먼저 → 오발송 방지) `MVP` ⭐
- **억제 리스트**(수신거부·죽은토큰·클레임 자동 제외) `MVP` ⭐
- **미리보기** · 템플릿 라이브러리/버전 `MVP+`
- **발송 승인 워크플로**(결재) `MVP+`(팀/규제)

## J. 플랫폼 / 멀티테넌시
- **Org/Workspace → Project → App** 계층, 크로스 프로젝트 대시보드 `MVP`
- **환경 분리(dev/staging/prod)** `MVP` — 프로젝트별 키/크레덴셜
- **마이그레이션 임포트**(OneSignal/FCM) `MVP+`(도입 마찰↓)
- **화이트라벨**(에이전시 리브랜딩) `MVP+`(SI/BYOC 무기)
- RBAC · API키 스코프/로테이션 · 감사로그 `MVP+`

## K. 인프라 / 신뢰성
- rate limit · idempotency · 재시도+**DLQ** `MVP`
- **웹훅**(HMAC 서명 + 큐 비동기 + 백오프 + 멱등 + 전송로그/재전송) — **Svix 재사용** `MVP+`
- OS 네이티브: **알림 채널/카테고리 · 뱃지 동기화 · 그룹/스레드 · 사운드** `MVP`

## L. 개발자 경험
- **SDK 매트릭스**: core / web / react / **webview(+Capacitor·Cordova)** / flutter / android / ios / electron `단계적`
- **서버 내장 MCP**(create_project·get_integration_snippet·send_test_push) `MVP+` — AI 개발 가속
- **OpenAPI-first** → SDK·문서·MCP·llms.txt 단일 파생 `MVP`

## M. AI 기능 (AI 순풍)
- **AI 카피라이팅**(문구 생성/최적화) `MVP+`
- ML 발송시간 예측 · 세그먼트 자동제안 · 자동 번역 `후순위`

## N. 컴플라이언스
- 수신거부/opt-out · GDPR export/삭제 · 동의 추적 · 데이터 리텐션 정책 `MVP+`

## 후순위 차별화 (검증 후)
- **iOS Live Activities / Android 진행형 알림**(배달추적·배차·라이브) — 강력하나 앱쪽 위젯 구현 복잡
- 이벤트 스트리밍(Kafka) · 상태페이지/SLA · 팀 협업

---

## 설계상 꼭 지킬 노트
1. **앱 삭제 감지** = 전송응답 unregistered 기반(실시간 100% 아님)
2. **개인화(이름 치환)** = 수신자별 개별 발송에서만, 토픽 브로드캐스트 불가
3. **A/B** = Firebase Remote Config ❌(앱설정용), **서버사이드 메시지 A/B** ⭕
4. **딥링크** = 푸시엔 네이티브 직접링크(payload), OneLink/FDL 불필요. 지연/어트리뷰션만 Branch/AppsFlyer
5. **지역** = GeoIP(서버, MaxMind) + locale/timezone(SDK 전송) 병행. EB는 LB뒤라 `X-Forwarded-For`

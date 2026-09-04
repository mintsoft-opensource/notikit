# MintApp Push (OSS) — 최종 기획서

> **셀프호스트 가능한 "유저 중심(user-centric)" 푸시 인프라.**
> FCM 위에 **사용자·계정 레이어**를 얹고, 멀티플랫폼 SDK + 관리 대시보드를 제공하며,
> 이 도커를 **고객 서버에 이식·관리하는 서비스(BYOC)** 로 수익화한다.
>
> 작성일: 2026-09-04 · 상태: 기획 확정(구현 전) · 위치: 현행 `push` 레포와 분리

## 문서 세트
- **README.md** (본 문서) — 비전·시장·경쟁·전략·MVP·리스크
- **[01-features.md](01-features.md)** — 전체 기능 카탈로그(우선순위)
- **[02-deployment-service.md](02-deployment-service.md)** — BYOC 배포 서비스·요금제
- **[03-server-architecture.md](03-server-architecture.md)** — 서버/API/DB/SDK/배포 설계
- **[04-si-playbook.md](04-si-playbook.md)** — SI(구축 의뢰) 진행

---

## 1. 비전 & 배경
- 이미 **MintApp(SaaS)** 운영 경험 있음 → **폭발 못 함**. 원인: **영업 부재 + 운영비**.
- 전환: **OSS(무료 유입) + BYOC(고객 서버)** 로 두 실패 원인을 정면 상쇄.
  - 영업 → **OSS-led PLG**(제품이 스스로 판매, 개발자 유입)
  - 운영비 → **BYOC**(고객이 자기 서버·자기 FCM 비용 부담, 당신은 얇은 컨트롤 플레인)

## 2. 핵심 차별점 (왜 FCM/경쟁자 대신)
FCM은 **토큰 중심**이라 없는 것 = 우리의 wedge:
1. **유저/계정 identity** — 토큰이 아니라 "유저 X"에게, 계정↔다중기기 연결, 로그인/로그아웃 재매핑
2. **멀티테넌트** — 프로젝트별 Firebase 자격증명 격리·암호화 (에이전시/SI가 여러 앱 대행)
3. **관리 대시보드** — 프로젝트/디바이스/토픽/템플릿/로그/통계
4. **멀티플랫폼 SDK 풀세트**(웹뷰 포함) — 경쟁 OSS 최대 약점
5. **셀프호스트/데이터주권** — 규제산업(금융/공공) 진입, 벤더락인 없음

> **한 줄:** "셀프호스트 가능한 오픈소스 OneSignal 대체 — 유저중심 FCM 릴레이 + 대시보드 + SDK 풀세트."

## 3. 가능 여부 (검증됨)
| 목표 | 가능 | 조건 |
|---|---|---|
| 오픈소스 공개 | ✅ | 시크릿·회사종속 sanitize + 라이선스/문서 |
| SDK 다종(web/webview/react/flutter/android/ios/electron) | ✅ | API 계약 안정 + 플랫폼별 토큰 획득 |
| Next.js/Node 재작성 | ✅ | 대량 fan-out 아키텍처(큐+워커) |
| BYOC 이식 서비스 | ✅ | 도커-퍼스트로 지으면 자연 연결 |

## 4. 시장 & AI 순풍
- 푸시 SW 시장: 정의따라 **$1.8B~$28B**, CAGR **15~27%**(고성장).
- **AI 순풍**: 2026 알림/대화량 **3~5배 폭증** 전망, 에이전트가 유저에게 선제 도달 → **identity 레이어 가치 상승**.
- **경계**: "셀프호스트+유저중심"은 전체 시장의 **슬라이스**(underserved). 폭발보다 **니치 소유 + 복리 성장**이 현실적.

## 5. 경쟁 지형
- **직접 OSS**: ntfy·Gotify(경량 homelab, 멀티테넌시/SDK 약함), Novu·Dittofeed·Laudspeaker(무겁고 마케팅 지향)
- **상용**: FCM(무료·토큰만), OneSignal, Airship/Braze(엔터), Knock/Courier(인프라)
- **앱빌더**: **nachocode**(노코드 웹뷰→앱, 푸시=얕은 부가기능) — **정면승부 X**, 층위 다름
- **재사용(경쟁 아님)**: 실시간=**Centrifugo/Soketi**, 웹훅=**Svix**, 배포=**Coolify/Kamal**

**nachocode 대응**: 같은 링(노코드 앱빌더) 안 올라감 → **인프라 층 + 개발자/엔터프라이즈 고객 + 셀프호스트/규제/멀티테넌트/identity**로 승부. 웹뷰 SDK가 "nachocode 밖 하이브리드 시장 전체"를 여는 열쇠.

## 6. 제품 사다리 & 비즈니스 모델
```
OSS 무료 셀프호스트  → 영업 문제 해결 (개발자 유입 = 유통 엔진)
BYOC 관리형 (1대 무료 → 2대째 유료) → 운영비 문제 해결 (고객 인프라 부담)
SI (구축 의뢰) → 최고 단가 (엔터프라이즈/공공), 유지보수 재발매출
※ 완전관리형 클라우드는 초기 배제 (운영비 재현 위험)
```
상세: [02-deployment-service.md](02-deployment-service.md) · [04-si-playbook.md](04-si-playbook.md)

## 7. MVP 범위 (스코프 절제 — 최우선)
> 전면 재작성·SDK 다종·컨트롤 플레인을 **동시에 시작하지 않는다.**

**코어 MVP:**
- 멀티프로젝트/Org · 디바이스/토큰 · **identify(유저)** · 개인/토픽 발송
- 템플릿+변수치환 · **딥링크(payload+네이티브)** · **테스트발송** · **억제리스트**
- docker-compose · 설치 마법사 · 기본 통계

**+ 국내 킬러:** **카카오 알림톡 폴백** (한국 시장 결정타)
**+ AI 한 스푼:** AI 카피라이팅
**후순위:** Live Activities · 저니 · 화이트라벨 · Electron · SI 컨트롤 플레인

## 8. 로드맵 (검증 우선)
1. **Step 1** — 코어 OSS 서버(도커) + JS/React·웹뷰 SDK
2. **Step 2** — OpenAPI-first 문서 + MCP(개발가속)
3. **Step 3** — 공개 & 반응 측정(GitHub·r/selfhosted) → **수요 검증**
4. **Step 4** — BYOC 컨트롤 플레인(무료1대→유료)
5. **Step 5** — 모바일 SDK 확장·카카오·AI·SI

**최소검증(빌드 전):** 랜딩+대기자명단 → 코어+SDK 공개 → 1회 런칭 → 스타/설치/인바운드 측정.

## 9. 리스크 (현실판)
| 리스크 | 완화 |
|---|---|
| **유통 실행력**(영업→개발자마케팅 전환) | 꾸준한 콘텐츠·문서·커뮤니티. 안 하면 또 묻힘 |
| **전환율 낮음**(무료→유료 1~5%) | 유입 볼륨 확보(유통), BYOC로 한계비용↓ |
| **시장이 슬라이스** | 규제/데이터주권 세그먼트 집중, AI 순풍 활용 |
| **스코프 폭발** | 코어 MVP부터, 나머지 검증 후 |
| **경쟁 이동**(Dittofeed/Novu) | "유저중심 셀프호스트 푸시" 니치 선점 |
| **현행 운영 리스크** | `push.lasee.biz`는 그대로 운영, 신규는 별도 |
| **법무/IP** | Apache-2.0 + 서드파티/상표 정리 |

## 10. 결론
- **전부 가능.** 시장 빈자리 뚜렷 + AI 순풍 + 실패원인(영업·운영비)을 모델이 정면 상쇄.
- **폭발보다 "니치 소유 + 복리"** 기대치. 성패는 **유통(개발자 마케팅) 지속**에 달림.
- **다음 액션**: 최소검증(랜딩/대기자) + 코어 MVP 스캐폴딩.

### 참고 출처
- [Novu vs Apprise vs Ntfy 2026 (Pi Stack)](https://www.pistack.xyz/posts/novu-vs-apprise-vs-ntfy-self-hosted-notification-infrastructure-guide-2026/)
- [Dittofeed (GitHub)](https://github.com/dittofeed/dittofeed) · [Centrifugo (GitHub)](https://github.com/centrifugal/centrifugo) · [Soketi (GitHub)](https://github.com/soketi/soketi)
- [Top 11 Push Platforms 2026 (Courier)](https://www.courier.com/blog/top-push-notification-platforms) · [Push Pricing 2026 (Courier)](https://www.courier.com/integrations/pricing/push-notifications)
- [2026 Comm Trends (Sinch)](https://sinch.com/blog/customer-communications-predictions/) · [Best Notification APIs for AI Agents (Sequenzy)](https://www.sequenzy.com/blog/best-notification-apis-for-ai-agents)

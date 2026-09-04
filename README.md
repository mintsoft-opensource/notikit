# Notikit

> **오픈소스 · 셀프호스트 가능 · 유저 중심(user-centric) 푸시 알림 툴킷.**
> FCM 위에 **사용자·계정 identity 레이어**를 얹고, 멀티플랫폼 SDK + 관리 대시보드를 제공.

`notikit.dev` · Apache-2.0 · 운영: MintSoft

## 무엇인가
- **유저 중심 푸시**: 토큰이 아니라 "유저 X"에게 발송, 계정↔다중기기 연결
- **멀티테넌트**: 프로젝트별 Firebase 자격증명 격리·암호화 (에이전시/SI 대행)
- **멀티플랫폼 SDK**: Web(JS/React) · WebView · Android(Kotlin/Java) · Swift · Flutter · React Native
- **셀프호스트**: `docker compose up` 한 방, 데이터 주권

## 모노레포 구조
```
apps/web            # Next.js 대시보드 + API + Swagger
packages/design     # 디자인 시스템(Tailwind v4 + shadcn/ui 토큰)
packages/sdk-core   # 공통 전송·API 클라이언트·타입
packages/sdk-web    # 브라우저 Web Push
packages/sdk-react  # React/Next hooks
sdks/android        # Kotlin/Java (Maven/JitPack)
sdks/swift          # Swift (SPM/CocoaPods)
sdks/flutter        # Dart (pub.dev)
sdks/react-native   # RN
mcp/                # 서버 내장 MCP (AI 개발 가속)
docs/plan/          # 기획 문서 세트
```

## 빠른 시작 (self-host)
```bash
cp .env.example .env      # NOTIKIT_ENCRYPTION_KEY 등 채우기
docker compose up -d      # web + worker + postgres + redis
open http://localhost:3000
```

## 개발
```bash
pnpm install
pnpm dev                  # apps/web (Next.js)
```

## 문서
- 기획/아키텍처: [`docs/plan/`](docs/plan/)
- API: `/docs` (Swagger UI) · OpenAPI 스펙: `/api/openapi.json`

## 라이선스
Apache-2.0

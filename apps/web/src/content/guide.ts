/**
 * 사용 가이드 본문.
 *
 * 한국어로 먼저 쓰고 번역을 나중에 얹는다. 지금은 모든 로케일이 한국어를 본다 —
 * 영어본은 아래 EN 에 남겨두고, 번역 단계에서 locale 별로 되살린다.
 */

export type GuideBlock =
  | { kind: "p"; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "note"; tone: "info" | "warn"; text: string };

export type GuideSection = { id: string; title: string; blocks: GuideBlock[] };

const KO: GuideSection[] = [
  {
    id: "concepts",
    title: "기본 개념",
    blocks: [
      {
        kind: "p",
        text: "notikit 은 유저 중심 푸시 플랫폼입니다. 토큰이 아니라 유저를 기준으로 발송하고, 클릭까지 추적해 통계를 냅니다.",
      },
      {
        kind: "table",
        head: ["개념", "설명"],
        rows: [
          ["프로젝트", "발송 단위이자 격리 단위. 각 프로젝트는 자기 api-key 와 Firebase 자격증명을 가집니다."],
          ["디바이스", "푸시 토큰 하나 = 디바이스 한 대. 앱 삭제가 감지되면 비활성 처리됩니다."],
          ["유저(external_id)", "고객 시스템의 유저 식별자. 디바이스를 유저에 바인딩하면 유저 단위 발송·통계가 가능해집니다."],
          ["토픽", "구독 기반 그룹. 디바이스가 구독하고, 토픽 발송은 구독자 전체로 나갑니다."],
          ["세그먼트", "유저 속성 규칙으로 정의한 동적 그룹. 발송 시점에 매칭합니다."],
        ],
      },
      {
        kind: "note",
        tone: "info",
        text: "클릭의 유저 귀속은 서버가 디바이스 바인딩에서 해석합니다. 클라이언트가 보낸 external_id 를 믿지 않습니다 — 그랬다면 등록 시 막아둔 사칭이 클릭 경로로 다시 열립니다.",
      },
    ],
  },
  {
    id: "auth",
    title: "인증",
    blocks: [
      {
        kind: "p",
        text: "키는 두 종류입니다. 용도를 섞으면 보안이 무너집니다.",
      },
      {
        kind: "table",
        head: ["키", "헤더", "어디에 두나", "할 수 있는 일"],
        rows: [
          ["api-key (nk_…)", "api-key", "클라이언트 SDK 에 포함 (공개)", "디바이스 등록, 유저 식별, 토픽 구독, 클릭 보고, 수신거부"],
          ["api-secret (sk_…)", "api-secret", "서버 전용 (절대 앱에 넣지 않음)", "발송"],
        ],
      },
      {
        kind: "note",
        tone: "warn",
        text: "api-key 는 앱에 실려 배포되므로 비밀이 아닙니다. 공격자가 가지고 있다고 전제하고 설계돼 있습니다. 발송은 api-secret 이 있어야만 가능합니다.",
      },
      {
        kind: "p",
        text: "남의 계정을 사칭하지 못하도록, external_id 를 다루는 요청에는 identity_hash 를 요구합니다. 고객 서버가 계산해 클라이언트에 내려주세요.",
      },
      {
        kind: "code",
        lang: "identity_hash = HMAC-SHA256(external_id, api_secret) → hex",
        code: `// Node.js — 고객 서버에서
import { createHmac } from "node:crypto";

const identityHash = createHmac("sha256", API_SECRET)
  .update(externalId)
  .digest("hex");

// 이 값을 로그인 응답에 담아 앱으로 내려줍니다.
// api_secret 자체는 절대 앱으로 내려보내지 마세요.`,
      },
      {
        kind: "list",
        items: [
          "identity_hash 필수(항상): 인박스 조회·읽음, 저니 등록, external_id 수신거부, 토큰 교체(유저 바인딩된 기기)",
          "identity_hash 필수(프로젝트 설정 시): 디바이스 등록의 external_id 바인딩, 바인딩 해제, 유저 식별",
          "프로젝트 설정 > 정책에서 '유저 검증 요구'를 끄면 후자는 생략됩니다(개발 중에만 권장)",
        ],
      },
    ],
  },
  {
    id: "quickstart",
    title: "빠른 시작",
    blocks: [
      { kind: "p", text: "1) 프로젝트를 만들고 2) Firebase 서비스 계정 JSON 을 올린 뒤 3) SDK 를 연동합니다." },
      {
        kind: "note",
        tone: "info",
        text: "Firebase 를 설정하지 않아도 발송을 호출할 수 있습니다. 이 경우 실제 배달 없이 로그만 남습니다(log-only) — 연동 전에 흐름을 확인할 때 유용합니다.",
      },
      {
        kind: "code",
        lang: "디바이스 등록 (모든 플랫폼 공통 · 공개 api-key)",
        code: `curl -X POST https://push.example.com/api/v1/devices \\
  -H "content-type: application/json" \\
  -H "api-key: nk_xxx" \\
  -d '{
    "token": "<FCM 등록 토큰>",
    "platform": "android",
    "external_id": "user-123",
    "identity_hash": "<서버계산 HMAC>",
    "locale": "ko-KR",
    "timezone": "Asia/Seoul"
  }'`,
      },
      {
        kind: "code",
        lang: "발송 (서버 전용 · api-secret 필요)",
        code: `curl -X POST https://push.example.com/api/v1/messages \\
  -H "content-type: application/json" \\
  -H "api-key: nk_xxx" \\
  -H "api-secret: sk_xxx" \\
  -d '{
    "type": "single",
    "target": "user-123",
    "title": "장바구니에 담아두신 상품",
    "body": "재고가 얼마 남지 않았어요",
    "deep_link": "myapp://cart"
  }'`,
      },
      {
        kind: "note",
        tone: "info",
        text: "발송 API 는 큐에 넣고 즉시 202 로 응답합니다. 실제 fan-out 은 워커가 처리합니다 — 수집과 전송을 분리해, 대량 발송이 API 응답을 붙잡지 않게 한 구조입니다.",
      },
    ],
  },
  {
    id: "sending",
    title: "발송",
    blocks: [
      {
        kind: "table",
        head: ["타입", "target", "대상"],
        rows: [
          ["single", "external_id", "그 유저의 활성 디바이스 전체"],
          ["topic", "토픽 이름", "그 토픽 구독자 전체"],
          ["segment", "세그먼트 이름", "속성 규칙에 맞는 유저의 활성 디바이스"],
          ["broadcast", "불필요", "프로젝트의 활성 디바이스 전체"],
        ],
      },
      { kind: "p", text: "예약 발송은 scheduled_at 에 ISO 8601 시각을 넣습니다. 과거 시각이면 즉시 발송으로 처리됩니다." },
      {
        kind: "code",
        lang: "예약 발송",
        code: `{
  "type": "topic",
  "target": "news",
  "title": "주간 소식",
  "body": "이번 주 인기 글을 모았어요",
  "scheduled_at": "2026-03-02T09:00:00+09:00"
}`,
      },
      {
        kind: "note",
        tone: "warn",
        text: "scheduled_at 을 주지 않으면 프로젝트의 방해금지 시간대 규칙이 적용됩니다. 조용한 시간에 걸리면 서버가 자동으로 그 이후로 미룹니다 — 즉시 나가야 하는 알림이라면 방해금지 설정을 확인하세요.",
      },
      {
        kind: "p",
        text: "발송 대상에서 자동으로 빠지는 것: 수신 거부한 유저·토큰, 비활성(앱 삭제 감지) 디바이스.",
      },
    ],
  },
  {
    id: "clicks",
    title: "클릭 추적",
    blocks: [
      {
        kind: "p",
        text: "발송 payload 의 data 에 notikit_log_id 가 실려 나갑니다. 알림을 눌렀을 때 이 값을 되돌려주면 클릭으로 집계됩니다. SDK 를 쓰면 자동으로 처리됩니다.",
      },
      {
        kind: "code",
        lang: "클릭 보고 (공개 api-key)",
        code: `curl -X POST https://push.example.com/api/v1/messages/click \\
  -H "content-type: application/json" \\
  -H "api-key: nk_xxx" \\
  -d '{
    "log_id": "<notikit_log_id>",
    "token": "<이 기기의 푸시 토큰>",
    "destination": "myapp://cart"
  }'`,
      },
      {
        kind: "list",
        items: [
          "유저는 서버가 토큰의 바인딩에서 해석합니다 — external_id 를 보내지 않습니다",
          "같은 발송·같은 기기의 재클릭은 무시됩니다(클릭률이 부풀지 않게)",
          "발송 시각 이후에 등록된 기기의 클릭은 거부됩니다 — 가짜 토큰을 등록해 과거 발송을 클릭하는 경로를 막습니다",
        ],
      },
    ],
  },
  {
    id: "tokens",
    title: "토큰 수명 관리",
    blocks: [
      {
        kind: "p",
        text: "FCM 토큰은 갱신됩니다. 새 토큰으로 그냥 등록하면 행이 하나 더 생겨 같은 사람에게 중복 발송됩니다. 반드시 교체 API 를 쓰세요.",
      },
      {
        kind: "code",
        lang: "토큰 교체",
        code: `curl -X POST https://push.example.com/api/v1/devices/rotate \\
  -H "content-type: application/json" \\
  -H "api-key: nk_xxx" \\
  -d '{
    "old_token": "<이전 토큰>",
    "new_token": "<새 토큰>",
    "identity_hash": "<유저 바인딩된 기기면 필수>"
  }'`,
      },
      {
        kind: "p",
        text: "교체는 기존 기기 행의 토큰을 제자리 갱신하므로 기기 id·토픽 구독·클릭 이력이 모두 보존됩니다.",
      },
      {
        kind: "p",
        text: "앱 삭제는 직접 알 수 없습니다. 워커가 매일 새벽 FCM dry-run(검증 전용, 유저에게 아무것도 보이지 않음)으로 전체 토큰을 점검해 죽은 토큰을 비활성 처리하고 '설치/삭제' 통계에 기록합니다.",
      },
    ],
  },
  {
    id: "metrics",
    title: "통계 지표 정의",
    blocks: [
      {
        kind: "p",
        text: "숫자의 의미가 모호하면 잘못된 판단으로 이어집니다. 이 플랫폼의 정의는 다음과 같습니다.",
      },
      {
        kind: "table",
        head: ["지표", "정의"],
        rows: [
          ["DAU / WAU / MAU", "해당 기간에 앱을 연 것으로 기록된 고유 기기 수. 유저 수는 힌트로 별도 표기합니다."],
          ["재방문율(stickiness)", "DAU ÷ MAU. MAU 가 0 이면 정의되지 않으므로 '—' 로 표시합니다."],
          ["클릭률", "클릭한 고유 유저 ÷ 발송 시점 대상 유저 수. 분모는 발송 당시 스냅샷이라 이후 유저 증감에 흔들리지 않습니다."],
          ["성공/대상", "FCM 이 받아들인 수 ÷ 발송 대상 토큰 수. FCM 수용은 배달 보장이 아니라 '토큰이 유효했다'는 뜻입니다."],
          ["미검증 기기", "등록만 되고 FCM 이 아직 받아준 적 없는 기기. 공개 api-key 로 임의 문자열도 등록되므로 그 규모를 드러냅니다."],
        ],
      },
      {
        kind: "note",
        tone: "warn",
        text: "분모가 0 인 비율은 0% 가 아니라 '—' 로 표시합니다. 0% 는 '아무도 안 읽었다'로 오독되기 때문입니다.",
      },
    ],
  },
  {
    id: "ops",
    title: "운영",
    blocks: [
      {
        kind: "p",
        text: "발송은 큐를 거칩니다. '발송 큐' 화면에서 대기·처리 중·예약 건과 최장 대기 시간을 볼 수 있습니다.",
      },
      {
        kind: "list",
        items: [
          "대기가 계속 쌓이고 최장 대기 시간이 자란다 → 워커가 멈췄거나 Firebase 설정이 없습니다",
          "예약 건수만 많다 → 정상입니다. 예약 시각이 되면 처리됩니다",
          "워커 없이 수동으로 밀어야 한다면 큐 화면의 '큐 처리' 버튼을 쓰세요",
        ],
      },
      {
        kind: "p",
        text: "워커는 프로젝트 목록을 커서로 끝까지 읽어 모든 프로젝트를 처리합니다. 큐 처리·저니 진행·웹훅 재시도·토큰 점검을 담당합니다.",
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "자주 겪는 문제",
    blocks: [
      {
        kind: "table",
        head: ["증상", "원인과 조치"],
        rows: [
          ["발송은 성공인데 알림이 안 온다", "Firebase 미설정이면 log-only 로 기록만 됩니다. 프로젝트 설정 > Firebase 를 확인하세요."],
          ["웹에서 알림이 두 번 뜬다", "서비스워커를 최신 템플릿으로 교체하세요. 서버는 웹에 data-only 로 보내고 워커가 표시를 담당합니다."],
          ["클릭이 집계되지 않는다", "서비스워커 등록 URL 에 base·key 쿼리가 붙어 있는지 확인하세요. SDK 의 register() 가 자동으로 붙입니다."],
          ["403 identity_hash invalid", "HMAC 키가 api_secret 인지, 대상 문자열이 external_id 그대로인지, 결과가 hex 인지 확인하세요."],
          ["같은 사람에게 두 번 온다", "토큰 갱신 시 재등록 대신 /devices/rotate 를 쓰는지 확인하세요."],
          ["DAU 가 활성 기기 수보다 크다", "비활성 기기가 접속을 보고하면 생길 수 있습니다. ping 은 활성 기기만 기록하므로 정상 경로에서는 발생하지 않습니다."],
        ],
      },
    ],
  },
];

const EN: GuideSection[] = [
  {
    id: "concepts",
    title: "Core concepts",
    blocks: [
      {
        kind: "p",
        text: "notikit is a user-centric push platform. You send to users rather than tokens, and clicks are tracked back into the statistics.",
      },
      {
        kind: "table",
        head: ["Concept", "Meaning"],
        rows: [
          ["Project", "The unit of sending and of isolation. Each project has its own api-key and Firebase credentials."],
          ["Device", "One push token = one device. Devices are deactivated once an uninstall is detected."],
          ["User (external_id)", "Your system's user identifier. Binding a device to a user enables user-level sending and stats."],
          ["Topic", "A subscription group. Devices subscribe, and a topic send reaches every subscriber."],
          ["Segment", "A dynamic group defined by user attribute rules, matched at send time."],
        ],
      },
      {
        kind: "note",
        tone: "info",
        text: "Click attribution is resolved server-side from the device binding. A client-supplied external_id is never trusted — doing so would reopen the impersonation path that identity verification closes at registration.",
      },
    ],
  },
  {
    id: "auth",
    title: "Authentication",
    blocks: [
      { kind: "p", text: "There are two keys. Mixing up their roles breaks the security model." },
      {
        kind: "table",
        head: ["Key", "Header", "Where it lives", "What it can do"],
        rows: [
          ["api-key (nk_…)", "api-key", "Shipped in client SDKs (public)", "Register devices, identify users, subscribe to topics, report clicks, opt out"],
          ["api-secret (sk_…)", "api-secret", "Server only — never in an app", "Send"],
        ],
      },
      {
        kind: "note",
        tone: "warn",
        text: "The api-key ships inside your app, so it is not a secret. The system is designed assuming an attacker has it. Sending requires the api-secret.",
      },
      {
        kind: "p",
        text: "To prevent impersonation, requests that touch an external_id require an identity_hash. Compute it on your server and hand it to the client.",
      },
      {
        kind: "code",
        lang: "identity_hash = HMAC-SHA256(external_id, api_secret) → hex",
        code: `// Node.js — on your server
import { createHmac } from "node:crypto";

const identityHash = createHmac("sha256", API_SECRET)
  .update(externalId)
  .digest("hex");

// Return this with your login response.
// Never ship api_secret itself to the app.`,
      },
      {
        kind: "list",
        items: [
          "Always required: inbox read/mark-read, journey enrollment, external_id suppression, token rotation for a user-bound device",
          "Required when the project enables it: external_id binding on device registration, unbinding, user identify",
          "Turning off “require identity verification” in project settings skips the second group (development only)",
        ],
      },
    ],
  },
  {
    id: "quickstart",
    title: "Quick start",
    blocks: [
      { kind: "p", text: "1) Create a project, 2) upload the Firebase service-account JSON, 3) wire up an SDK." },
      {
        kind: "note",
        tone: "info",
        text: "You can call the send API before configuring Firebase. Nothing is delivered — only logs are written (log-only), which is useful for verifying the flow first.",
      },
      {
        kind: "code",
        lang: "Register a device (all platforms · public api-key)",
        code: `curl -X POST https://push.example.com/api/v1/devices \\
  -H "content-type: application/json" \\
  -H "api-key: nk_xxx" \\
  -d '{
    "token": "<FCM registration token>",
    "platform": "android",
    "external_id": "user-123",
    "identity_hash": "<server-computed HMAC>",
    "locale": "en-US",
    "timezone": "America/New_York"
  }'`,
      },
      {
        kind: "code",
        lang: "Send (server only · api-secret required)",
        code: `curl -X POST https://push.example.com/api/v1/messages \\
  -H "content-type: application/json" \\
  -H "api-key: nk_xxx" \\
  -H "api-secret: sk_xxx" \\
  -d '{
    "type": "single",
    "target": "user-123",
    "title": "Still in your cart",
    "body": "Only a few left in stock",
    "deep_link": "myapp://cart"
  }'`,
      },
      {
        kind: "note",
        tone: "info",
        text: "The send API enqueues and returns 202 immediately; a worker performs the fan-out. Collection is deliberately separated from delivery so a large send never blocks the API response.",
      },
    ],
  },
  {
    id: "sending",
    title: "Sending",
    blocks: [
      {
        kind: "table",
        head: ["Type", "target", "Audience"],
        rows: [
          ["single", "external_id", "Every active device of that user"],
          ["topic", "Topic name", "Every subscriber of that topic"],
          ["segment", "Segment name", "Active devices of users matching the attribute rules"],
          ["broadcast", "Not needed", "Every active device in the project"],
        ],
      },
      { kind: "p", text: "For a scheduled send, pass an ISO 8601 timestamp in scheduled_at. A past timestamp is treated as send-now." },
      {
        kind: "code",
        lang: "Scheduled send",
        code: `{
  "type": "topic",
  "target": "news",
  "title": "Weekly digest",
  "body": "The most-read posts this week",
  "scheduled_at": "2026-03-02T09:00:00Z"
}`,
      },
      {
        kind: "note",
        tone: "warn",
        text: "Without scheduled_at, the project's quiet-hours policy applies: a send that lands inside quiet hours is automatically deferred past them. Check that policy if a notification must go out immediately.",
      },
      { kind: "p", text: "Automatically excluded from every send: opted-out users and tokens, and devices marked inactive by uninstall detection." },
    ],
  },
  {
    id: "clicks",
    title: "Click tracking",
    blocks: [
      {
        kind: "p",
        text: "Every send carries notikit_log_id in its data payload. Return that value when the notification is tapped and it is counted as a click. The SDKs do this for you.",
      },
      {
        kind: "code",
        lang: "Report a click (public api-key)",
        code: `curl -X POST https://push.example.com/api/v1/messages/click \\
  -H "content-type: application/json" \\
  -H "api-key: nk_xxx" \\
  -d '{
    "log_id": "<notikit_log_id>",
    "token": "<this device's push token>",
    "destination": "myapp://cart"
  }'`,
      },
      {
        kind: "list",
        items: [
          "The user is resolved server-side from the token's binding — do not send external_id",
          "Repeat clicks on the same send from the same device are ignored so click rate is not inflated",
          "Clicks from devices registered after the send are rejected, closing the “register a fake token and click an old send” path",
        ],
      },
    ],
  },
  {
    id: "tokens",
    title: "Token lifecycle",
    blocks: [
      {
        kind: "p",
        text: "FCM tokens rotate. Registering the new token creates a second row and the same person receives duplicates — always use the rotation API.",
      },
      {
        kind: "code",
        lang: "Rotate a token",
        code: `curl -X POST https://push.example.com/api/v1/devices/rotate \\
  -H "content-type: application/json" \\
  -H "api-key: nk_xxx" \\
  -d '{
    "old_token": "<previous token>",
    "new_token": "<new token>",
    "identity_hash": "<required for a user-bound device>"
  }'`,
      },
      { kind: "p", text: "Rotation updates the token on the existing device row, so the device id, topic subscriptions and click history are all preserved." },
      {
        kind: "p",
        text: "Uninstalls cannot be observed directly. Each night the worker checks every token with an FCM dry-run (validation only — nothing reaches the user), deactivates dead tokens and records them in the install/uninstall statistics.",
      },
    ],
  },
  {
    id: "metrics",
    title: "Metric definitions",
    blocks: [
      { kind: "p", text: "Ambiguous numbers lead to wrong decisions. These are the definitions this platform uses." },
      {
        kind: "table",
        head: ["Metric", "Definition"],
        rows: [
          ["DAU / WAU / MAU", "Unique devices recorded as having opened the app in the window. The user count is shown separately as a hint."],
          ["Stickiness", "DAU ÷ MAU. Undefined when MAU is 0, shown as “—”."],
          ["Click rate", "Unique users who clicked ÷ audience users at send time. The denominator is a snapshot, so later user growth does not move it."],
          ["Delivered/Audience", "Accepted by FCM ÷ tokens targeted. FCM acceptance means the token was valid, not that the notification arrived."],
          ["Unverified devices", "Registered but never yet accepted by FCM. The public api-key lets arbitrary strings be registered, so this surfaces that volume."],
        ],
      },
      {
        kind: "note",
        tone: "warn",
        text: "A ratio with a zero denominator is shown as “—”, not 0%. 0% would be misread as “nobody read it”.",
      },
    ],
  },
  {
    id: "ops",
    title: "Operations",
    blocks: [
      { kind: "p", text: "Sends go through a queue. The “Send queue” screen shows queued, processing and scheduled items along with the longest wait." },
      {
        kind: "list",
        items: [
          "Queue growing and the longest wait climbing → the worker is down, or Firebase is not configured",
          "Only the scheduled count is high → normal; they are processed when due",
          "To push items through manually without a worker, use “Process queue” on that screen",
        ],
      },
      {
        kind: "p",
        text: "The worker pages through the full project list with a cursor so every project is processed. It handles queue processing, journey advancement, webhook retries and token health checks.",
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    blocks: [
      {
        kind: "table",
        head: ["Symptom", "Cause and fix"],
        rows: [
          ["Send succeeds but no notification arrives", "Without Firebase credentials the send is log-only. Check Project settings › Firebase."],
          ["Duplicate notifications on web", "Replace the service worker with the current template. The server sends data-only to web and the worker owns display."],
          ["Clicks are not counted", "Check that the service worker URL carries the base and key query parameters. The SDK's register() adds them automatically."],
          ["403 identity_hash invalid", "Verify the HMAC key is api_secret, the message is the raw external_id, and the digest is hex."],
          ["The same person receives two notifications", "Make sure token refresh calls /devices/rotate instead of re-registering."],
          ["DAU exceeds the active device count", "Possible if inactive devices report opens. The ping endpoint only records active devices, so this should not occur on the normal path."],
        ],
      },
    ],
  },
];

/** 번역이 붙기 전까지는 로케일과 무관하게 한국어. EN 은 번역 단계에서 연결한다. */
export function guideSections(_locale: string): GuideSection[] {
  void EN;
  return KO;
}

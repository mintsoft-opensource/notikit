/**
 * 필수 설정 검증 — Node 런타임 전용. `instrumentation.ts` 가 부팅 때 한 번 부른다.
 *
 * 여기서 죽으면 컨테이너가 뜨지 않고, 업데이터는 readiness 실패로 보고 롤백한다.
 * 반대로 통과시키면 설정이 깨진 인스턴스가 "성공한 업데이트"로 남는다.
 */

/** 없으면 앱이 제 기능을 못 하는 값들 */
const REQUIRED: ReadonlyArray<readonly [string, string]> = [
  ["DATABASE_URL", "Postgres 연결 문자열"],
  ["NOTIKIT_ENCRYPTION_KEY", "프로젝트 자격증명 암호화 키 (분실 시 복호화 불가)"],
];

/** 관리자 세션 서명 — 둘 중 하나만 있으면 된다 */
const SESSION_KEYS = ["SESSION_SECRET", "NOTIKIT_ENCRYPTION_KEY"] as const;

/**
 * 부족한 설정 목록. 비어 있으면 정상. 테스트에서 종료 없이 검사만 할 때도 쓴다.
 *
 * `NodeJS.ProcessEnv` 가 아니라 느슨한 레코드를 받는다 — 그 타입은 `NODE_ENV` 를
 * 필수로 요구해서, 검사 대상만 담은 테스트 픽스처가 타입에 안 맞는다.
 */
export function missingEnv(env: Record<string, string | undefined> = process.env): string[] {
  const missing = REQUIRED.filter(([k]) => !env[k]).map(([k, why]) => `${k}: ${why}`);
  if (!SESSION_KEYS.some((k) => env[k])) {
    missing.push(`${SESSION_KEYS.join(" 또는 ")}: 관리자 세션 서명`);
  }
  return missing;
}

/** 예시 파일의 자리표시자 접두사 — 이 값 그대로 뜬 인스턴스는 공개 저장소를 읽은 누구나 관리자다 */
const PLACEHOLDER_PREFIX = "change-me";
/** 암호화·서명 키 최소 길이 */
const MIN_KEY_LENGTH = 32;
const SECRET_KEYS = ["NOTIKIT_ENCRYPTION_KEY", "SESSION_SECRET", "ADMIN_TOKEN"] as const;
const LENGTH_CHECKED = new Set<string>(["NOTIKIT_ENCRYPTION_KEY", "SESSION_SECRET"]);

/**
 * 안전하지 않은 비밀값 목록. 비어 있으면 정상.
 *
 * 저장소가 공개라 `.env.example` 의 값도 공개다. `cp .env.example .env` 만 하고 띄운 설치는
 * `x-admin-token: change-me-admin-token` 한 줄로 전 조직의 superadmin 이 되고, 공개된 암호화 키로
 * 세션을 위조하거나 유출된 DB 의 자격증명을 풀 수 있다. 값이 "있는지"만 보던 검사로는 막지 못했다.
 */
export function insecureEnv(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  for (const k of SECRET_KEYS) {
    const v = env[k];
    if (!v) continue;
    if (v.startsWith(PLACEHOLDER_PREFIX)) out.push(`${k}: .env.example 의 예시값 그대로입니다`);
    else if (LENGTH_CHECKED.has(k) && v.length < MIN_KEY_LENGTH) out.push(`${k}: ${MIN_KEY_LENGTH}자 이상이어야 합니다`);
  }
  return out;
}

export function verifyEnvOrExit(): void {
  const missing = missingEnv();
  // 개발 서버(next dev)는 예시값으로 돌려 볼 수 있게 둔다. 운영 빌드(compose·이미지)는 막는다.
  const insecure = process.env.NODE_ENV === "production" ? insecureEnv() : [];
  if (missing.length === 0 && insecure.length === 0) return;

  const lines = [
    ...(missing.length ? [`[notikit] 필수 설정이 없어 시작할 수 없습니다:`, ...missing.map((m) => `  - ${m}`)] : []),
    ...(insecure.length ? [`[notikit] 안전하지 않은 비밀값으로는 시작하지 않습니다:`, ...insecure.map((m) => `  - ${m}`)] : []),
    `.env 를 확인하세요. 새 값은 \`openssl rand -hex 32\` 로 만들 수 있습니다. 자세한 내용은 .env.example 참고.`,
  ];
  console.error(lines.join("\n"));
  // throw 만으로는 Next 가 요청 시점까지 끌고 갈 수 있다. 부팅에서 확실히 끊는다.
  process.exit(1);
}

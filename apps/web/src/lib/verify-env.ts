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

export function verifyEnvOrExit(): void {
  const missing = missingEnv();
  if (missing.length === 0) return;

  console.error(
    `[notikit] 필수 설정이 없어 시작할 수 없습니다:\n` +
      missing.map((m) => `  - ${m}`).join("\n") +
      `\n.env 를 확인하세요. 자세한 내용은 .env.example 참고.`
  );
  // throw 만으로는 Next 가 요청 시점까지 끌고 갈 수 있다. 부팅에서 확실히 끊는다.
  process.exit(1);
}

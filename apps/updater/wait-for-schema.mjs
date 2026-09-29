/**
 * 업데이터가 쓰는 테이블(update_jobs)이 생길 때까지 기다린다.
 *
 * 신규 설치에서 업데이터는 postgres 가 healthy 가 되자마자 뜨지만, 스키마는 migrate 가
 * 만든다. 예전엔 기동 직후 첫 쿼리가 `relation "update_jobs" does not exist` 로 던져
 * 프로세스가 죽고, migrate 가 끝날 때까지 restart 루프를 돌며 스택 트레이스를 쏟았다.
 * 연결 오류도 같은 취급이다 — 관리형 Postgres 가 잠깐 안 받는 것으로 죽을 이유는 없다.
 */
const DEFAULT_INTERVAL_MS = 2000;

export async function waitForTable(exists, { intervalMs = DEFAULT_INTERVAL_MS, sleep, onWait } = {}) {
  const pause = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    let error = null;
    try {
      if (await exists()) return;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }
    onWait?.(attempt, error);
    await pause(intervalMs);
  }
}

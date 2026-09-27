/** 한 프로세스가 기억하는 발송 id 수. 넘으면 오래된 것부터 버린다. */
export const RECEIPT_DEDUPE_SIZE = 200;

/**
 * 수신 보고 중복 방지 — "이 발송은 이미 보고했다"를 기억한다.
 *
 * FCM 은 같은 메시지를 다시 배달할 수 있고(APNs 도 마찬가지), 안드로이드는 앱이 죽어 있으면
 * 백그라운드 핸들러를 새 프로세스에서 부른다. 서버가 `(log, device)` 유니크로 한 번만 세므로
 * 도달 수가 부풀지는 않지만, 기억하지 않으면 **재배달마다 요청이 한 번씩 더 나간다** —
 * 대형 발송 직후에는 그게 그대로 수신 보고 rate limit 을 깎아먹는다.
 *
 * 프로세스 안에서만 유효한 기억이다. 영속 저장을 쓰지 않는 이유: 플랫폼마다 저장소가 다르고
 * (IndexedDB · AsyncStorage · 없음), 서버가 이미 최종 판정을 하므로 여기서 놓친 중복은
 * 낭비된 요청 한 건으로 끝난다. 잘못 기억해서 **보고를 영영 빠뜨리는 쪽**이 더 나쁘다.
 */
export class ReceiptDedupe {
  private readonly seen = new Set<string>();

  constructor(private readonly max: number = RECEIPT_DEDUPE_SIZE) {}

  /**
   * 처음 보는 발송이면 기억하고 `true`. 이미 본 발송(또는 빈 id)이면 `false`.
   * 보고 **전에** 잡아 둔다 — 두 번째 배달이 첫 요청의 응답을 기다리는 사이에 끼어들 수 있다.
   */
  claim(logId: string): boolean {
    if (!logId || this.seen.has(logId)) return false;
    this.seen.add(logId);
    // Set 은 삽입 순서를 지킨다 — 가장 오래 전에 본 것부터 버린다
    if (this.seen.size > this.max) {
      const oldest = this.seen.values().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    return true;
  }

  /**
   * 기억을 되돌린다. 보고가 **다시 시도할 가치가 있는 이유**로 실패했을 때만 부른다 —
   * 404·403 까지 풀어 주면 재배달마다 같은 요청이 같은 답을 받으러 나간다.
   */
  release(logId: string): void {
    this.seen.delete(logId);
  }

  has(logId: string): boolean {
    return this.seen.has(logId);
  }

  get size(): number {
    return this.seen.size;
  }
}

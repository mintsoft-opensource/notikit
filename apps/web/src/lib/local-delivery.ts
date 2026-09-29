/**
 * 받는 사람 현지 시각 발송 — "각자 현지 09:00".
 *
 * 묶음 키는 IANA 이름이 아니라 그 시점의 **UTC 오프셋**이다. 이름은 수백 개인데 "지금 현지 몇 시인가"는
 * 오프셋만으로 정해지므로, 같은 오프셋은 동시에 발송 시각이 된다(회차 수 = 오프셋 수 ≤ 40).
 *
 * 회차(pass) 단위로 돈다: 한 회차는 그 순간 시각이 된 오프셋만 보내고, 아직 안 된 오프셋은 다음 회차로 미룬다.
 * 이미 보낸 오프셋 목록을 진행 상태에 남기므로, 다음 회차가 커서를 처음으로 되돌려 다시 훑어도
 * **지난 회차에 받은 기기에게 두 번 가지 않는다**(도래 여부는 기기가 아니라 오프셋의 성질이다).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { devices, pushUsers } from "@/db/schema";
import { zoneOffsetLabel } from "@/lib/quiet-hours";
import type { Db } from "@/lib/audience-count";

/** "HH:MM" */
const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 미루는 창. 발송을 걸어 둔 지 이만큼 지나면 남은 오프셋도 즉시 보낸다 — 이틀 뒤에 도착하는 알림은 알림이 아니다. */
export const LOCAL_WINDOW_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

export type LocalTime = { hour: number; minute: number };

export function parseLocalTime(v: string | null | undefined): LocalTime | null {
  const m = v ? LOCAL_TIME_RE.exec(v) : null;
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/** 오프셋 딱지("+09:00","-03:30") → 분 */
export function offsetMinutes(label: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(label);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * 그 오프셋 묶음에서 `t` 가 가리키는 **가장 가까운** 시각(epoch ms).
 * 오늘 치가 이미 지났으면 지난 시각을 그대로 돌려준다 — 호출부는 `<= now` 로 도래를 판정한다.
 */
export function localDueAt(offset: string, t: LocalTime, now: Date): number {
  const shift = offsetMinutes(offset) * MINUTE_MS;
  const local = now.getTime() + shift;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  return dayStart + (t.hour * 60 + t.minute) * MINUTE_MS - shift;
}

/** 진행 상태에 남기는 현지 시각 회차 정보 */
export type LocalState = {
  /** 끝난 회차에서 이미 보낸 오프셋 묶음 */
  sentOffsets: string[];
  /**
   * 진행 중인 회차가 도래를 재는 기준 시각(ISO). 회차 안에서 이 값을 고정해야
   * 도중에 죽었다 이어 갈 때 "회차 중간에 새로 도래한 묶음"이 생기지 않는다 —
   * 생기면 커서 앞쪽 기기를 건너뛴 채 그 묶음이 끝난 것으로 표시된다.
   */
  passAt: string | null;
  /** 다음 회차를 열 시각(ISO). null 이면 미룬 묶음이 없다. */
  nextPassAt: string | null;
  /**
   * 진행 중인 회차에서 이미 보내기 시작한 묶음. 회차 중간에 죽었다 이어 가도 이 값이 있어야
   * 회차를 닫을 때 앞쪽에서 보낸 묶음이 "보냄"으로 남는다 — 빠지면 다음 회차에서 또 보낸다.
   */
  sending?: string[];
};

/** 한 회차 동안의 누적 — 어떤 묶음을 보냈고 어떤 묶음을 언제로 미뤘는지 */
export type LocalPass = {
  time: LocalTime;
  /** 도래 판정 기준 시각(회차 내내 고정) */
  at: Date;
  /** 창이 지나 더는 미루지 않는다 */
  expired: boolean;
  done: Set<string>;
  sending: Set<string>;
  deferAt: number | null;
};

export function openLocalPass(time: LocalTime, prev: LocalState | undefined, now: Date, expired: boolean): LocalPass {
  // 회차 중간이면(passAt 있음) 보내던 묶음과 미뤄 둔 시각까지 이어받는다
  const midPass = Boolean(prev?.passAt);
  return {
    time,
    at: midPass ? new Date(prev!.passAt!) : now,
    expired,
    done: new Set(prev?.sentOffsets ?? []),
    sending: new Set(midPass ? prev!.sending ?? [] : []),
    deferAt: midPass && prev!.nextPassAt ? Date.parse(prev!.nextPassAt) : null,
  };
}

export type ZoneRow = { token: string };

/**
 * 페이지를 "지금 보낼 것"과 "미룰 것"으로 가른다. 미룬 것은 개수만 세고 pass.deferAt 을 앞당긴다.
 * 판정을 **상한·예약보다 먼저** 해야 미룬 기기가 빈도 상한 슬롯을 태우지 않는다.
 */
export function splitDue<T extends ZoneRow>(
  pass: LocalPass,
  rows: T[],
  zoneOf: (row: T) => string | null | undefined
): { send: T[]; deferred: number } {
  const labels = new Map<string, string>();
  const send: T[] = [];
  let deferred = 0;
  for (const row of rows) {
    const zone = zoneOf(row) ?? "";
    let offset = labels.get(zone);
    if (offset === undefined) labels.set(zone, (offset = zoneOffsetLabel(zone, pass.at)));
    if (pass.done.has(offset)) continue; // 지난 회차에 이미 받았다
    const at = localDueAt(offset, pass.time, pass.at);
    if (!pass.expired && at > pass.at.getTime()) {
      deferred++;
      pass.deferAt = pass.deferAt === null ? at : Math.min(pass.deferAt, at);
      continue;
    }
    pass.sending.add(offset);
    send.push(row);
  }
  return { send, deferred };
}

/** 회차 도중에 남기는 상태 — 크래시로 이어 갈 때 기준 시각과 미룬 시각을 잃지 않는다. */
export function passState(pass: LocalPass): LocalState {
  return {
    sentOffsets: [...pass.done].sort(),
    passAt: pass.at.toISOString(),
    nextPassAt: pass.deferAt === null ? null : new Date(pass.deferAt).toISOString(),
    sending: [...pass.sending].sort(),
  };
}

/** 회차를 닫는다 — 보낸 묶음을 누적하고, 미룬 게 있으면 다음 회차 시각을 남긴다. */
export function closeLocalPass(pass: LocalPass): LocalState {
  return {
    sentOffsets: [...new Set([...pass.done, ...pass.sending])].sort(),
    passAt: null,
    nextPassAt: pass.deferAt === null ? null : new Date(pass.deferAt).toISOString(),
  };
}

/**
 * 토큰 → 시간대. 사람의 시간대(identify 로 받은 값)가 먼저고, 없으면 기기 등록값이다 —
 * 사람이 밝힌 값이 기기 로캘보다 정확하고, 기기를 바꿔도 따라간다.
 */
export async function loadZones(db: Db, projectId: string, tokens: string[]): Promise<Map<string, string | null>> {
  if (tokens.length === 0) return new Map();
  const rows = await db
    .select({ token: devices.token, zone: sql<string | null>`coalesce(${pushUsers.timezone}, ${devices.timezone})` })
    .from(devices)
    .leftJoin(pushUsers, eq(devices.userId, pushUsers.id))
    .where(and(eq(devices.projectId, projectId), inArray(devices.token, tokens)));
  return new Map(rows.map((r) => [r.token, r.zone]));
}

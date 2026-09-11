import { verifyLicense, type LicenseResult } from "@notikit/license";

/**
 * 이 설치의 라이선스 상태.
 *
 * 검증은 **오프라인**이다. 공개키가 이미지에 들어 있고 네트워크를 쓰지 않는다 —
 * 폐쇄망 고객에게는 이 방법밖에 없다.
 *
 * 만료가 곧 정지는 아니다. 만료되면 업데이트만 막히고 푸시는 계속 나간다.
 * 결제 상태로 고객의 알림을 끊는 것은 고객의 고객에게 피해를 준다.
 */
const PUBLIC_KEY = (process.env.NOTIKIT_LICENSE_PUBLIC_KEY ?? "").replace(/\\n/g, "\n");

/** 만료가 이 안으로 들어오면 콘솔이 갱신을 재촉한다 */
export const RENEWAL_WARNING_DAYS = 30;

export function getLicense(): LicenseResult {
  return verifyLicense(process.env.NOTIKIT_LICENSE_KEY, PUBLIC_KEY);
}

/** 업데이트를 받을 자격이 있는가 — 만료·위조·미설정은 모두 받을 수 없다 */
export function canReceiveUpdates(result: LicenseResult = getLicense()): boolean {
  return result.status === "valid";
}

/** 콘솔에 내려보낼 요약. 라이선스 원문(서명 포함)은 내려보내지 않는다. */
export function licenseSummary(result: LicenseResult = getLicense()) {
  if (result.status === "valid" || result.status === "expired") {
    return {
      status: result.status,
      customerName: result.license.customerName,
      customerId: result.license.customerId,
      expiresAt: result.license.expiresAt,
      daysRemaining: result.daysRemaining,
      channel: result.license.channel,
      limits: result.license.limits,
      expiringSoon: result.status === "valid" && result.daysRemaining <= RENEWAL_WARNING_DAYS,
    };
  }
  return {
    status: result.status,
    reason: result.status === "invalid" ? result.reason : undefined,
  };
}

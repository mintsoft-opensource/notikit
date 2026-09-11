export interface LicenseLimits {
  projects?: number;
  devices?: number;
  sendsPerMonth?: number;
}

export interface LicensePayload {
  v: 1;
  customerId: string;
  customerName: string;
  issuedAt: string;
  expiresAt: string;
  channel: string;
  limits: LicenseLimits;
  notes?: string;
}

export interface LicenseClaims {
  customerId: string;
  customerName?: string;
  /** ISO 날짜. 만료 없는 라이선스는 회수할 방법이 없어 허용하지 않는다 */
  expiresAt: string;
  issuedAt?: string;
  channel?: string;
  limits?: LicenseLimits;
  notes?: string;
}

export type LicenseResult =
  | { status: "valid"; license: LicensePayload; daysRemaining: number }
  /** 서명은 맞지만 기간이 지났다 — 서비스는 계속 돈다 */
  | { status: "expired"; license: LicensePayload; daysRemaining: number }
  | { status: "invalid"; reason: string }
  | { status: "missing" };

export function generateKeyPair(): { publicKey: string; privateKey: string };
export function issueLicense(claims: LicenseClaims, privateKeyPem: string): string;
export function verifyLicense(token: string | undefined | null, publicKeyPem: string | undefined | null, now?: Date): LicenseResult;

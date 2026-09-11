/**
 * 라이선스 — 발급과 검증.
 *
 * **오프라인에서 검증된다.** 공개키만 있으면 되고 네트워크가 필요 없다. 폐쇄망
 * 고객에게는 이것 말고 방법이 없다 — 서버에 물어보는 방식은 인터넷이 없는 곳에서
 * 그냥 동작하지 않는다.
 *
 * 형식은 `notikit.<payload>.<signature>` 로, JWS 와 닮았지만 알고리즘 협상이 없다.
 * Ed25519 하나만 쓴다. 알고리즘을 페이로드가 고르게 두면 `alg: none` 류의 우회가
 * 생긴다 — 고를 수 없으면 우회할 것도 없다.
 *
 * 의존성이 없다(node:crypto 만 쓴다). web, 업데이트 서버, 발급 CLI 가 같은 코드를
 * 쓰게 하려면 빌드 단계가 없어야 한다.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

const PREFIX = "notikit";
const VERSION = 1;

const b64u = {
  encode: (buf) => Buffer.from(buf).toString("base64url"),
  decode: (s) => Buffer.from(s, "base64url"),
};

/** 발급자용 키 한 쌍. 비밀키는 절대 이미지나 저장소에 들어가지 않는다. */
export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/**
 * 라이선스 발급. `privateKeyPem` 은 발급 서버(또는 오프라인 장비)에만 있어야 한다.
 *
 * @param {{customerId: string, customerName?: string, expiresAt: string,
 *          channel?: string, limits?: object, notes?: string}} claims
 */
export function issueLicense(claims, privateKeyPem) {
  if (!claims?.customerId) throw new Error("customerId is required");
  if (!claims?.expiresAt || Number.isNaN(Date.parse(claims.expiresAt))) {
    // 만료 없는 라이선스는 회수할 방법이 없다. 영구 계약이라도 긴 만료를 쓴다.
    throw new Error("expiresAt must be an ISO date");
  }

  const payload = {
    v: VERSION,
    customerId: claims.customerId,
    customerName: claims.customerName ?? claims.customerId,
    issuedAt: claims.issuedAt ?? new Date().toISOString(),
    expiresAt: new Date(claims.expiresAt).toISOString(),
    channel: claims.channel ?? "stable",
    limits: claims.limits ?? {},
    ...(claims.notes ? { notes: claims.notes } : {}),
  };

  const body = b64u.encode(JSON.stringify(payload));
  const signature = sign(null, Buffer.from(`${PREFIX}.${body}`), createPrivateKey(privateKeyPem));
  return `${PREFIX}.${body}.${b64u.encode(signature)}`;
}

/**
 * 검증. 반환값의 `status` 로 갈린다.
 *
 *  - `valid`    : 서명 OK, 기간 내
 *  - `expired`  : 서명 OK, 기간 지남 — **서비스를 멈추지 않는다.** 업데이트만 막는다.
 *  - `invalid`  : 서명 불일치·형식 오류·공개키 없음
 *  - `missing`  : 라이선스가 설정되지 않음
 *
 * 만료와 위조를 구분하는 것이 중요하다. 만료는 영업이 해결할 일이고, 위조는
 * 보안 사건이다. 하나로 뭉뚱그리면 둘 다 제대로 대응하지 못한다.
 */
export function verifyLicense(token, publicKeyPem, now = new Date()) {
  if (!token) return { status: "missing" };
  if (!publicKeyPem) return { status: "invalid", reason: "공개키가 설정되지 않았습니다" };

  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    return { status: "invalid", reason: "형식이 올바르지 않습니다" };
  }
  const [, body, sig] = parts;

  let ok = false;
  try {
    ok = verify(null, Buffer.from(`${PREFIX}.${body}`), createPublicKey(publicKeyPem), b64u.decode(sig));
  } catch {
    return { status: "invalid", reason: "서명을 확인할 수 없습니다" };
  }
  if (!ok) return { status: "invalid", reason: "서명이 일치하지 않습니다" };

  // 서명을 통과한 뒤에야 내용을 읽는다. 순서를 뒤집으면 검증되지 않은 값을 먼저 다룬다.
  let payload;
  try {
    payload = JSON.parse(b64u.decode(body).toString("utf8"));
  } catch {
    return { status: "invalid", reason: "내용을 읽을 수 없습니다" };
  }
  if (payload?.v !== VERSION) return { status: "invalid", reason: "지원하지 않는 라이선스 버전입니다" };

  const expiresAt = Date.parse(payload.expiresAt);
  if (Number.isNaN(expiresAt)) return { status: "invalid", reason: "만료일이 올바르지 않습니다" };

  const expired = expiresAt < now.getTime();
  return {
    status: expired ? "expired" : "valid",
    license: payload,
    daysRemaining: Math.floor((expiresAt - now.getTime()) / 86_400_000),
  };
}

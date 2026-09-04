/**
 * Notikit @notikit/core 실행 예제 (Node).
 * 서버가 떠 있는 상태에서:  node examples/node-quickstart.mjs
 * 환경변수: NOTIKIT_BASE_URL, NOTIKIT_ADMIN_TOKEN
 */
import { createHmac } from "node:crypto";
import { NotikitClient } from "@notikit/core";

const BASE = process.env.NOTIKIT_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.NOTIKIT_ADMIN_TOKEN ?? "change-me-admin-token";

async function admin(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": ADMIN },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  // 1) 프로젝트 생성 → 키 발급
  const { data } = await admin("/api/admin/projects", { name: "quickstart" });
  const apiKey = data.project.apiKey;
  const apiSecret = data.api_secret;
  console.log("api-key:", apiKey);

  const ext = "user-123";
  const identityHash = createHmac("sha256", apiSecret).update(ext).digest("hex");

  // 2) 클라이언트 SDK (공개키만)
  const client = new NotikitClient({ baseUrl: BASE, apiKey });
  await client.registerDevice({ token: "demo-token", platform: "web", externalId: ext, identityHash });
  await client.identify({ externalId: ext, attributes: { plan: "pro" }, identityHash });
  await client.subscribe("news", "demo-token");
  console.log("등록/식별/구독 완료");

  // 3) 서버에서 발송 (secret 포함)
  const server = new NotikitClient({ baseUrl: BASE, apiKey, apiSecret });
  const msg = await server.send({ title: "안녕", body: "첫 푸시", type: "single", target: ext });
  console.log("발송:", msg);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

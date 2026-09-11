#!/usr/bin/env node
/**
 * 라이선스 발급 CLI.
 *
 * 비밀키는 인자로 받지 않는다 — 인자는 호스트의 프로세스 목록에 그대로 보인다.
 * 파일 경로나 환경변수로 받는다.
 *
 *   node tools/license/issue.mjs keygen
 *   NOTIKIT_LICENSE_PRIVATE_KEY_FILE=./private.pem \
 *     node tools/license/issue.mjs issue --customer acme --name "Acme" --months 12 --projects 10
 */
import { readFileSync, writeFileSync } from "node:fs";
import { generateKeyPair, issueLicense, verifyLicense } from "../../packages/license/index.mjs";

const [cmd, ...rest] = process.argv.slice(2);

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--")) continue;
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function privateKey() {
  const file = process.env.NOTIKIT_LICENSE_PRIVATE_KEY_FILE;
  if (file) return readFileSync(file, "utf8");
  const inline = process.env.NOTIKIT_LICENSE_PRIVATE_KEY;
  if (inline) return inline.replace(/\\n/g, "\n");
  console.error("NOTIKIT_LICENSE_PRIVATE_KEY_FILE 또는 NOTIKIT_LICENSE_PRIVATE_KEY 가 필요합니다");
  process.exit(1);
}

if (cmd === "keygen") {
  const { publicKey, privateKey: priv } = generateKeyPair();
  writeFileSync("license-private.pem", priv, { mode: 0o600 });
  writeFileSync("license-public.pem", publicKey);
  console.log("license-private.pem  ← 절대 저장소·이미지에 넣지 마세요");
  console.log("license-public.pem   ← NOTIKIT_LICENSE_PUBLIC_KEY 로 이미지에 넣습니다");
} else if (cmd === "issue") {
  const f = flags(rest);
  if (!f.customer) {
    console.error("--customer 가 필요합니다");
    process.exit(1);
  }
  const months = Number(f.months ?? 12);
  const expires = new Date();
  expires.setMonth(expires.getMonth() + months);

  const limits = {};
  if (f.projects) limits.projects = Number(f.projects);
  if (f.devices) limits.devices = Number(f.devices);
  if (f.sends) limits.sendsPerMonth = Number(f.sends);

  const token = issueLicense(
    {
      customerId: f.customer,
      customerName: f.name ?? f.customer,
      expiresAt: expires.toISOString(),
      channel: f.channel ?? "stable",
      limits,
      notes: f.notes,
    },
    privateKey()
  );
  console.log(token);
} else if (cmd === "verify") {
  const f = flags(rest);
  const pub = f.pubkey ? readFileSync(f.pubkey, "utf8") : process.env.NOTIKIT_LICENSE_PUBLIC_KEY;
  console.log(JSON.stringify(verifyLicense(f.token ?? process.env.NOTIKIT_LICENSE_KEY, pub), null, 2));
} else {
  console.error("usage: issue.mjs <keygen|issue|verify> [--flags]");
  process.exit(1);
}

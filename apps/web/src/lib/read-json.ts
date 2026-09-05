/** 요청 본문을 바이트 상한 내에서만 파싱 — 읽는 도중 초과하면 즉시 중단(버퍼링으로 인한 리소스 소진 방지) */
export async function readJsonLimited(req: Request, maxBytes = 32_768): Promise<unknown> {
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > maxBytes) throw new PayloadTooLargeError();

  const body = req.body;
  if (!body) {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new PayloadTooLargeError();
    return text ? JSON.parse(text) : {};
  }

  // 스트리밍 읽기 — 누적 바이트가 상한을 넘는 즉시 중단
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new PayloadTooLargeError();
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8").replace(/^﻿/, "");
  return text ? JSON.parse(text) : {};
}

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload too large");
    this.name = "PayloadTooLargeError";
  }
}

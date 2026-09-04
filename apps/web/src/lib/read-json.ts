/** 요청 본문을 바이트 상한 내에서만 파싱 (파싱 전 크기 가드 — 리소스 소진 방지) */
export async function readJsonLimited(req: Request, maxBytes = 32_768): Promise<unknown> {
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > maxBytes) throw new PayloadTooLargeError();
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new PayloadTooLargeError();
  return text ? JSON.parse(text) : {};
}

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload too large");
    this.name = "PayloadTooLargeError";
  }
}

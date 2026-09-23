import { describe, it, expect } from "vitest";
import { encodeCommand, parseReply, parseRedisUrl } from "./redis";

describe("redis RESP", () => {
  it("encodes commands as RESP arrays of bulk strings", () => {
    expect(encodeCommand(["INCR", "nk:rl:a:1"]).toString()).toBe("*2\r\n$4\r\nINCR\r\n$9\r\nnk:rl:a:1\r\n");
  });

  it("encodes multi-byte arguments by byte length, not character count", () => {
    const encoded = encodeCommand(["SET", "키"]).toString();
    expect(encoded).toContain("$3\r\n키\r\n"); // 문자 1개지만 UTF-8 3바이트
  });

  it("parses integer, simple string and error replies", () => {
    expect(parseReply(Buffer.from(":42\r\n"))).toEqual({ value: 42, next: 5 });
    expect(parseReply(Buffer.from("+OK\r\n"))).toEqual({ value: "OK", next: 5 });
    expect(parseReply(Buffer.from("-ERR nope\r\n"))?.error).toBe("ERR nope");
  });

  it("parses bulk strings and null bulk", () => {
    expect(parseReply(Buffer.from("$3\r\nabc\r\n"))?.value).toBe("abc");
    expect(parseReply(Buffer.from("$-1\r\n"))?.value).toBeNull();
  });

  it("parses nested arrays", () => {
    expect(parseReply(Buffer.from("*2\r\n:1\r\n$2\r\nhi\r\n"))?.value).toEqual([1, "hi"]);
  });

  it("returns null while the reply is still incomplete", () => {
    expect(parseReply(Buffer.from("$5\r\nab"))).toBeNull();
    expect(parseReply(Buffer.from("*2\r\n:1\r\n"))).toBeNull();
    expect(parseReply(Buffer.from(":4"))).toBeNull();
  });

  it("reports the offset so a pipelined stream can be drained", () => {
    const stream = Buffer.from(":7\r\n+OK\r\n");
    const first = parseReply(stream, 0);
    expect(first?.value).toBe(7);
    expect(parseReply(stream, first!.next)?.value).toBe("OK");
  });
});

describe("parseRedisUrl", () => {
  it("defaults host/port and rejects other schemes", () => {
    expect(parseRedisUrl("redis://localhost")).toMatchObject({ host: "localhost", port: 6379, tls: false });
    expect(parseRedisUrl("http://localhost:6379")).toBeNull();
    expect(parseRedisUrl("not a url")).toBeNull();
  });

  it("reads credentials, db index and TLS", () => {
    expect(parseRedisUrl("rediss://user:p%40ss@cache.example.com:6380/3")).toEqual({
      host: "cache.example.com",
      port: 6380,
      tls: true,
      username: "user",
      password: "p@ss",
      db: 3,
    });
  });
});

// deno test supabase/functions/_shared/body_test.ts
import { readJsonBody } from "./body.ts";

const MAX = 16 * 1024;
const enc = new TextEncoder();

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** 無 Content-Length 的串流；記錄實際被拉取了多少 bytes */
function stream(chunk: Uint8Array, maxChunks: number) {
  const pulled = { bytes: 0, cancelled: false };
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (n++ >= maxChunks) return c.close();
      pulled.bytes += chunk.byteLength;
      c.enqueue(chunk);
    },
    cancel() {
      pulled.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { req: new Request("http://x/", { method: "POST", body }), pulled };
}

/** 讓 JSON 恰好 n bytes（以 3-byte 的「中」填充，再以 ASCII 補齊） */
function jsonOfBytes(n: number): string {
  const head = '{"command":{"type":"settle"},"pad":"';
  const tail = '"}';
  let room = n - enc.encode(head + tail).length;
  const cjk = Math.floor(room / 3);
  room -= cjk * 3;
  const s = head + "中".repeat(cjk) + "a".repeat(room) + tail;
  assert(enc.encode(s).length === n, "fixture size");
  return s;
}

Deno.test("恰好 16 KiB（含多位元組字元）可以讀取", async () => {
  const r = await readJsonBody(new Request("http://x/", { method: "POST", body: jsonOfBytes(MAX) }), MAX);
  assert(r.kind === "ok", JSON.stringify(r));
});

Deno.test("16 KiB + 1 byte → too_large（以 bytes 計算，不是字元數）", async () => {
  const s = jsonOfBytes(MAX + 1);
  assert(s.length < MAX, "字元數小於上限，但 bytes 超過");
  const r = await readJsonBody(new Request("http://x/", { method: "POST", body: s }), MAX);
  assert(r.kind === "too_large", JSON.stringify(r));
});

Deno.test("Content-Length 明確超過上限：不讀取 body", async () => {
  const { req, pulled } = stream(new Uint8Array(1024), 10_000);
  const withLen = new Request(req, { headers: { "content-length": String(10 * 1024 * 1024) } });
  const r = await readJsonBody(withLen, MAX);
  assert(r.kind === "too_large", JSON.stringify(r));
  // Request 建構時 runtime 可能預先拉取少量資料；重點是沒有讀到上限
  assert(pulled.bytes < MAX, `pulled ${pulled.bytes}`);
});

Deno.test("無 Content-Length 的無限串流：超過上限即停止並取消，不會讀完", async () => {
  const { req, pulled } = stream(new Uint8Array(1024).fill(0x20), 1_000_000); // 最多 ~1 GB
  const r = await readJsonBody(req, MAX);
  assert(r.kind === "too_large", JSON.stringify(r));
  assert(pulled.bytes <= MAX + 2 * 1024, `pulled ${pulled.bytes} bytes`);
  assert(pulled.cancelled, "stream cancelled");
});

Deno.test("Content-Length 謊報為較小值：仍以實際 bytes 為準", async () => {
  const { req, pulled } = stream(new Uint8Array(1024).fill(0x20), 1_000);
  const lying = new Request(req, { headers: { "content-length": "10" } });
  const r = await readJsonBody(lying, MAX);
  assert(r.kind === "too_large", JSON.stringify(r));
  assert(pulled.bytes <= MAX + 2 * 1024, `pulled ${pulled.bytes}`);
});

Deno.test("空 body、非 JSON、非物件、非 UTF-8", async () => {
  const mk = (b?: BodyInit) => new Request("http://x/", { method: "POST", body: b });
  assert((await readJsonBody(mk(), MAX)).kind === "ok", "empty");
  assert((await readJsonBody(mk("  "), MAX)).kind === "ok", "blank");
  assert((await readJsonBody(mk("{"), MAX)).kind === "invalid", "bad json");
  assert((await readJsonBody(mk("[1]"), MAX)).kind === "invalid", "array");
  assert((await readJsonBody(mk(new Uint8Array([0x7b, 0xff, 0x7d])), MAX)).kind === "invalid", "utf8");
});

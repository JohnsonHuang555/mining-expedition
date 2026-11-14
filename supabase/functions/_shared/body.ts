// Request body 讀取（有上限）。
//
// 不使用 req.text() / req.json()：它們會先把整個 body 讀進記憶體。這裡逐段讀取原始 bytes，
// 一超過上限就取消串流並回傳 too_large，超限前不解碼、不累積超過上限的資料。
// Content-Length 明確超過上限時直接拒絕；但 header 可能不存在（chunked）或不正確，所以仍以實際讀到的 bytes 為準。

export type BodyResult =
  | { kind: "ok"; value: Record<string, unknown> }
  | { kind: "too_large" }
  | { kind: "invalid"; message: string };

export async function readJsonBody(req: Request, maxBytes: number): Promise<BodyResult> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > maxBytes) {
    await req.body?.cancel().catch(() => {});
    return { kind: "too_large" };
  }
  if (!req.body) return { kind: "ok", value: {} };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { kind: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "invalid", message: "could not read request body" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "invalid", message: "body must be UTF-8 JSON" };
  }
  if (text.trim() === "") return { kind: "ok", value: {} };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { kind: "invalid", message: "body must be JSON" };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { kind: "invalid", message: "body must be a JSON object" };
  return { kind: "ok", value: v as Record<string, unknown> };
}

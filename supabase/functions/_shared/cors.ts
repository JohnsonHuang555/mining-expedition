// CORS 允許來源（GAME_API_ALLOWED_ORIGIN）。
//
// - 未設定：`*`（本地開發；API 只靠 Bearer token，不使用 cookie）。
// - 設定：以逗號分隔的允許清單。每一項是完整的 origin（https://example.com），或只含一個 `*` 的 Vercel Preview 樣式
//   （https://mining-expedition-*-johnson.vercel.app）。`*` 只比對 [a-z0-9-]（不含「.」），所以不能跨網域。
// - 符合 → 回傳該 origin（加上 Vary: Origin）；不符合 → 不回傳 Access-Control-Allow-Origin（瀏覽器會擋下）。
// CORS 只限制瀏覽器；API 的安全邊界仍是 JWT 驗證與伺服器端規則。

export type OriginRule = { exact: string } | { prefix: string; suffix: string };

const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

/** 解析允許清單；格式錯誤的項目丟棄（不會因此變成允許全部） */
export function parseAllowedOrigins(raw: string | undefined | null): OriginRule[] | "*" {
  if (raw === undefined || raw === null || raw.trim() === "") return "*";
  const rules: OriginRule[] = [];
  for (const item of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const stars = item.split("*").length - 1;
    if (stars === 0) {
      if (ORIGIN_RE.test(item)) rules.push({ exact: item });
    } else if (stars === 1 && item.startsWith("https://")) {
      const [prefix, suffix] = item.split("*") as [string, string];
      // `*` 前後都要有固定的文字：前面是專案名稱，後面必須以 "-" 開頭（Vercel 的 team / scope 後綴，例如 -johnson.vercel.app）。
      // 不允許 https://*、https://*.vercel.app、https://foo*.vercel.app（任何人都能建立 fooxxx.vercel.app）這類過寬的樣式
      if (prefix.length > "https://".length && /^-[a-z0-9-]*\.[a-z0-9.-]+$/.test(suffix) && ORIGIN_RE.test(prefix + "x" + suffix)) {
        rules.push({ prefix, suffix });
      }
    }
  }
  return rules;
}

export function matchOrigin(rules: OriginRule[] | "*", origin: string | null): string | null {
  if (rules === "*") return "*";
  if (!origin) return null;
  const o = origin.toLowerCase();
  for (const r of rules) {
    if ("exact" in r) {
      if (o === r.exact) return origin;
    } else if (o.startsWith(r.prefix) && o.endsWith(r.suffix) && o.length > r.prefix.length + r.suffix.length) {
      const middle = o.slice(r.prefix.length, o.length - r.suffix.length);
      if (/^[a-z0-9-]+$/.test(middle)) return origin;
    }
  }
  return null;
}

export const CORS_BASE = {
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, idempotency-key, idempotency-expire, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "idempotent-replayed, x-engine-version, server-timing, retry-after",
  "Access-Control-Max-Age": "600",
};

/** 這個請求的 CORS 標頭 */
export function corsHeaders(rules: OriginRule[] | "*", origin: string | null): Record<string, string> {
  const allowed = matchOrigin(rules, origin);
  if (allowed === null) return { ...CORS_BASE, Vary: "Origin" };
  if (allowed === "*") return { ...CORS_BASE, "Access-Control-Allow-Origin": "*" };
  return { ...CORS_BASE, "Access-Control-Allow-Origin": allowed, Vary: "Origin" };
}

// deno test --no-config supabase/functions/_shared/cors_test.ts（不依賴外部套件）
function assertEquals(actual: unknown, expected: unknown, msg = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
import { corsHeaders, matchOrigin, parseAllowedOrigins, requiresExplicitOrigins } from "./cors.ts";

const rules = parseAllowedOrigins("https://staging.example.com, https://mining-expedition-*-johnson.vercel.app, http://localhost:3000");

Deno.test("未設定：允許全部（本地開發）", () => {
  assertEquals(parseAllowedOrigins(undefined), "*");
  assertEquals(corsHeaders("*", "https://anything.test")["Access-Control-Allow-Origin"], "*");
});

Deno.test("完整 origin 與 Vercel Preview 樣式", () => {
  assertEquals(matchOrigin(rules, "https://staging.example.com"), "https://staging.example.com");
  assertEquals(matchOrigin(rules, "http://localhost:3000"), "http://localhost:3000");
  assertEquals(matchOrigin(rules, "https://mining-expedition-git-feature-x-johnson.vercel.app"), "https://mining-expedition-git-feature-x-johnson.vercel.app");
  assertEquals(matchOrigin(rules, "https://mining-expedition-abc123-johnson.vercel.app"), "https://mining-expedition-abc123-johnson.vercel.app");
});

Deno.test("不允許：其他網域、跨越網域的 *、子網域偽裝、缺少 Origin", () => {
  for (const o of [
    "https://evil.example.com",
    "https://mining-expedition-x.evil.com-johnson.vercel.app",
    "https://mining-expedition-a.b-johnson.vercel.app",
    "https://mining-expedition--johnson.vercel.app.evil.com",
    "http://mining-expedition-abc-johnson.vercel.app",
    "https://staging.example.com.evil.com",
  ]) {
    assertEquals(matchOrigin(rules, o), null, o);
  }
  assertEquals(matchOrigin(rules, null), null);
  const h = corsHeaders(rules, "https://evil.example.com");
  assertEquals(h["Access-Control-Allow-Origin"], undefined);
  assertEquals(h.Vary, "Origin");
});

Deno.test("過寬或格式錯誤的樣式會被丟棄（不會變成允許全部）", () => {
  assertEquals(parseAllowedOrigins("https://*, https://*.vercel.app, https://foo*.vercel.app, *, https://a*b*c.com, not-a-url"), []);
  assertEquals(matchOrigin(parseAllowedOrigins("https://*.vercel.app"), "https://anyone.vercel.app"), null);
});

Deno.test("Cloud（https 的 SUPABASE_URL）沒有設定允許清單：拒絕所有瀏覽器 origin（fail closed）", () => {
  assertEquals(requiresExplicitOrigins("https://abcdefghijklmnopqrst.supabase.co"), true);
  assertEquals(requiresExplicitOrigins("http://kong:8000"), false);
  assertEquals(requiresExplicitOrigins(undefined), false);
  const cloud = parseAllowedOrigins(undefined, true);
  assertEquals(cloud, []);
  assertEquals(corsHeaders(cloud, "https://mining-expedition.vercel.app")["Access-Control-Allow-Origin"], undefined);
  assertEquals(parseAllowedOrigins("", true), []);
  assertEquals(parseAllowedOrigins(undefined, false), "*"); // 本地維持相容
});

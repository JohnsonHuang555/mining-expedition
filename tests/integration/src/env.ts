/**
 * 真正啟動的 Supabase Local 連線資訊。
 * 優先讀環境變數；沒有時呼叫 `supabase status -o env`（開發容器內的 CLI）。
 * 找不到時直接失敗：整合測試不能在沒有 Supabase 的情況下「默默通過」。
 */
import { execFileSync } from "node:child_process";

export interface SupabaseEnv {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  dbUrl: string;
  functionsUrl: string;
}

export function supabaseEnv(): SupabaseEnv {
  let v: Record<string, string | undefined> = {
    API_URL: process.env.SUPABASE_URL,
    ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    DB_URL: process.env.SUPABASE_DB_URL,
  };
  if (!v.API_URL || !v.ANON_KEY || !v.SERVICE_ROLE_KEY || !v.DB_URL) {
    let raw: string;
    try {
      raw = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      throw new Error(`Supabase Local is not running (supabase status failed). Run \`pnpm supabase:start\` first.\n${e}`);
    }
    const s: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
      if (m?.[1]) s[m[1]] = m[2] ?? "";
    }
    v = {
      API_URL: s.API_URL,
      ANON_KEY: s.ANON_KEY || s.PUBLISHABLE_KEY,
      SERVICE_ROLE_KEY: s.SERVICE_ROLE_KEY || s.SECRET_KEY,
      DB_URL: s.DB_URL,
    };
  }
  for (const k of ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY", "DB_URL"]) {
    if (!v[k]) throw new Error(`missing ${k} from supabase status`);
  }
  return { apiUrl: v.API_URL!, anonKey: v.ANON_KEY!, serviceRoleKey: v.SERVICE_ROLE_KEY!, dbUrl: v.DB_URL!, functionsUrl: `${v.API_URL}/functions/v1` };
}

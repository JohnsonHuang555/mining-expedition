"use client";

import type { Session } from "@supabase/supabase-js";
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";
import { getSupabase } from "./supabase";

export type AuthStatus = "loading" | "signed_in" | "signed_out" | "unconfigured";

export interface AuthContextValue {
  status: AuthStatus;
  userId: string | null;
  email: string | null;
  signIn(email: string, password: string): Promise<string | null>;
  signUp(email: string, password: string): Promise<string | null>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Supabase Auth 錯誤 → 玩家看得懂的訊息（不顯示內部細節） */
export function authMessage(code: string | undefined, fallback: string): string {
  switch (code) {
    case "invalid_credentials":
      return "Email 或密碼錯誤";
    case "user_already_exists":
    case "email_exists":
      return "這個 Email 已經註冊，請直接登入";
    case "weak_password":
      return "密碼太弱（至少 6 個字元）";
    case "email_address_invalid":
    case "validation_failed":
      return "請輸入正確的 Email";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "嘗試次數太多，請稍後再試";
    case "email_not_confirmed":
      return "請先完成 Email 驗證";
    default:
      return fallback;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      setStatus("unconfigured");
      return;
    }
    let cancelled = false;
    // Session 自動恢復：從 localStorage 讀取（必要時先更新 token）
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setStatus(data.session ? "signed_in" : "signed_out");
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setStatus(s ? "signed_in" : "signed_out");
    });
    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      userId: session?.user.id ?? null,
      email: session?.user.email ?? null,
      async signIn(email, password) {
        const supabase = getSupabase();
        if (!supabase) return "尚未設定 Supabase";
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return error ? authMessage(error.code, "登入失敗，請稍後再試") : null;
      },
      async signUp(email, password) {
        const supabase = getSupabase();
        if (!supabase) return "尚未設定 Supabase";
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) return authMessage(error.code, "註冊失敗，請稍後再試");
        if (!data.session) return "註冊成功，請到信箱完成驗證後再登入";
        return null;
      },
      async signOut() {
        await getSupabase()?.auth.signOut();
      },
    }),
    [session, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}

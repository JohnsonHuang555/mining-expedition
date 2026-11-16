"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Panel, PixelButton } from "@/components/ui/pixel";
import { useAuth } from "@/lib/auth/auth-provider";

/**
 * 公開註冊是否顯示（建置時決定）。封閉測試設為 "false"：只顯示登入。
 * 這只是畫面；真正的限制是 Supabase Auth 的「關閉註冊」設定（docs/DEPLOYMENT.md）。
 */
export const signupEnabled = (v: string | undefined = process.env.NEXT_PUBLIC_SIGNUP_ENABLED) => v !== "false";
const APP_ENV = process.env.NEXT_PUBLIC_APP_ENV ?? "";
/** 測試環境標記：NEXT_PUBLIC_APP_ENV=test（舊值 staging 也接受） */
const IS_TEST_ENV = APP_ENV === "test" || APP_ENV === "staging";

export function LoginForm({ allowSignup = signupEnabled() }: { allowSignup?: boolean } = {}) {
  const auth = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("expired") === "1") setMessage("登入已過期，請重新登入");
  }, []);
  useEffect(() => {
    if (auth.status === "signed_in") router.replace("/");
  }, [auth.status, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage(null);
    const err = mode === "signin" ? await auth.signIn(email.trim(), password) : await auth.signUp(email.trim(), password);
    setPending(false);
    if (err) setMessage(err);
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Panel className="w-full max-w-sm">
        <h1 className="text-center text-2xl font-black tracking-widest text-gold">⛏ 挖礦探險隊</h1>
        <p className="mt-1 text-center text-xs text-parchment-dim">挖掘、收集、離線也不停的礦坑冒險</p>
        {IS_TEST_ENV && (
          <p className="mt-3 bg-crystal/15 px-2 py-1 text-center text-xs text-crystal" data-testid="env-badge">
            TEST・封閉測試環境（尚未正式開放）
          </p>
        )}
        {!allowSignup && (
          <p className="mt-3 text-center text-xs text-parchment-dim" data-testid="signup-closed">
            目前為封閉測試：請使用受邀的測試帳號登入。
          </p>
        )}
        <div className={`mt-5 grid gap-2 ${allowSignup ? "grid-cols-2" : "grid-cols-1"}`} role="tablist">
          {(allowSignup ? (["signin", "signup"] as const) : (["signin"] as const)).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => {
                setMode(m);
                setMessage(null);
              }}
              className={`py-2 text-sm font-bold ${mode === m ? "bg-ember text-cave-950" : "bg-cave-700 text-parchment-dim"}`}
            >
              {m === "signin" ? "登入" : "註冊"}
            </button>
          ))}
        </div>
        <form className="mt-4 flex flex-col gap-3" onSubmit={submit}>
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-cave-950 px-3 py-2 font-mono text-parchment shadow-[0_0_0_3px_#000] outline-none focus:shadow-[0_0_0_3px_var(--color-ember)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            密碼
            <input
              type="password"
              required
              minLength={6}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-cave-950 px-3 py-2 font-mono text-parchment shadow-[0_0_0_3px_#000] outline-none focus:shadow-[0_0_0_3px_var(--color-ember)]"
            />
          </label>
          {message && (
            <p className="text-sm text-danger" role="alert">
              {message}
            </p>
          )}
          <PixelButton type="submit" className="mt-1 py-3 text-base" disabled={pending || auth.status === "loading" || auth.status === "unconfigured"}>
            {pending ? "處理中…" : mode === "signin" ? "進入礦坑" : "建立帳號"}
          </PixelButton>
          {auth.status === "unconfigured" && <p className="text-xs text-danger">尚未設定 Supabase 環境變數。</p>}
        </form>
      </Panel>
    </main>
  );
}

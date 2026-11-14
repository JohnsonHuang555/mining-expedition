"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { useAuth } from "@/lib/auth/auth-provider";
import { disposeGameRuntime, gameRuntime } from "@/lib/game/runtime";
import { Panel, PixelButton } from "@/components/ui/pixel";
import { CreateCharacter } from "./CreateCharacter";
import { Dashboard } from "./Dashboard";
import { OfflineReportModal } from "./OfflineReportModal";
import { RuntimeContext, useController, useGame } from "./runtime-context";

/** 登入狀態 → 遊戲狀態的進入點。未登入一律導向 /login。 */
export function GameApp() {
  const auth = useAuth();
  const router = useRouter();
  const expired = useRef(false);

  useEffect(() => {
    if (auth.status === "signed_out") {
      disposeGameRuntime();
      router.replace(expired.current ? "/login?expired=1" : "/login");
    }
  }, [auth.status, router]);

  const runtime = useMemo(
    () =>
      auth.status === "signed_in" && auth.userId
        ? gameRuntime(auth.userId, () => {
            expired.current = true; // token 更新失敗：登入已過期
          })
        : null,
    [auth.status, auth.userId],
  );

  if (auth.status === "unconfigured") return <Splash text="尚未設定 Supabase（NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY）" />;
  if (auth.status !== "signed_in" || !runtime) return <Splash text="載入中…" />;

  const signOut = async () => {
    disposeGameRuntime();
    await auth.signOut();
  };

  return (
    <RuntimeContext.Provider value={runtime}>
      <GameScreens email={auth.email} onSignOut={() => void signOut()} />
    </RuntimeContext.Provider>
  );
}

function GameScreens({ email, onSignOut }: { email: string | null; onSignOut(): void }) {
  const controller = useController();
  const phase = useGame((s) => s.phase);
  const view = useGame((s) => s.view);
  const error = useGame((s) => s.error);
  const sync = useGame((s) => s.sync);

  // 掛載時開始同步；Strict Mode 的重複掛載由 controller 的計數處理（只會 bootstrap 一次、只有一個計時器）
  useEffect(() => {
    controller.start();
    const onVisibility = () => (document.visibilityState === "visible" ? controller.onResume() : controller.onHidden());
    const onOnline = () => controller.onResume();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onOnline);
      controller.stop();
    };
  }, [controller]);

  if (phase === "no_character") return <CreateCharacter onSignOut={onSignOut} />;
  if (phase === "error" && !view)
    return (
      <Splash text={error ?? sync.message ?? "無法連線到伺服器"}>
        <p className="text-xs text-parchment-dim">會自動重試，也可以手動重試。</p>
        <div className="mt-4 flex justify-center gap-3">
          <PixelButton onClick={() => void controller.retryBootstrap()}>重試</PixelButton>
          <PixelButton tone="ghost" onClick={onSignOut}>
            登出
          </PixelButton>
        </div>
      </Splash>
    );
  if (!view) return <Splash text="連線到礦坑…" />;
  return (
    <>
      <Dashboard email={email} onSignOut={onSignOut} />
      {view.state.pendingOfflineReport && <OfflineReportModal report={view.state.pendingOfflineReport} />}
    </>
  );
}

export function Splash({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Panel className="w-full max-w-sm text-center">
        <div className="text-2xl font-black tracking-widest text-gold">⛏ 挖礦探險隊</div>
        <p className="mt-3 text-sm" role="status">
          {text}
        </p>
        {children}
      </Panel>
    </main>
  );
}

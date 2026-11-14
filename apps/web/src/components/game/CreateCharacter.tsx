"use client";

import { Panel, PixelButton } from "@/components/ui/pixel";
import { useController, useGame } from "./runtime-context";

/**
 * 建立角色。目前的 character-create API 不接受任何參數（TECHNICAL_SPEC §10.2），
 * 初始狀態完全由伺服器決定（木製十字鎬 Lv1、新手礦坑，D10）。名稱與外觀選擇待 API 支援後加入。
 */
export function CreateCharacter({ onSignOut }: { onSignOut(): void }) {
  const controller = useController();
  const busy = useGame((s) => s.busy);
  const notice = useGame((s) => s.notice);
  const sync = useGame((s) => s.sync);
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Panel className="w-full max-w-md">
        <h1 className="text-center text-2xl font-black tracking-widest text-gold">建立礦工</h1>
        <div className="mx-auto mt-4 w-24">
          <svg viewBox="0 0 12 16" className="pixelated h-auto w-full" aria-hidden="true">
            <rect x="3" y="0" width="6" height="3" fill="#fcd34d" />
            <rect x="2" y="2" width="8" height="1" fill="#f59e0b" />
            <rect x="4" y="3" width="4" height="4" fill="#f3e2bf" />
            <rect x="6" y="4" width="1" height="1" fill="#140b07" />
            <rect x="3" y="7" width="6" height="5" fill="#2563eb" />
            <rect x="3" y="12" width="2" height="4" fill="#43281a" />
            <rect x="7" y="12" width="2" height="4" fill="#43281a" />
            <rect x="10" y="5" width="1" height="8" fill="#9a7350" />
            <rect x="8" y="4" width="4" height="2" fill="#c9d1d9" />
          </svg>
        </div>
        <ul className="mt-4 space-y-1 text-sm text-parchment-dim">
          <li>・初始裝備：木製十字鎬 Lv1</li>
          <li>・從「新手礦坑」0 m 開始自動挖掘</li>
          <li>・離開遊戲時礦工會繼續挖掘（最多 12 小時）</li>
        </ul>
        {(notice || (!sync.ok && sync.message)) && (
          <p className="mt-3 text-sm text-danger" role="alert">
            {notice ?? sync.message}
          </p>
        )}
        <PixelButton className="mt-5 w-full py-3 text-base" disabled={busy !== null} onClick={() => void controller.createCharacter()}>
          {busy === "create" ? "建立中…" : "開始探險"}
        </PixelButton>
        <button type="button" onClick={onSignOut} className="mt-3 w-full text-center text-xs text-parchment-dim underline">
          登出
        </button>
      </Panel>
    </main>
  );
}

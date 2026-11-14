import type { ItemId } from "@mining/game-data";

/** 像素風物品圖示（以顏色區分；不使用外部美術資產） */
const COLORS: Record<string, [string, string]> = {
  stone: ["#8b8b8b", "#5f5f5f"],
  coal: ["#3a3a3a", "#1a1a1a"],
  copper: ["#d97745", "#9a4b25"],
  iron_ore: ["#b9a89a", "#7d6c60"],
  silver: ["#e5e7eb", "#9ca3af"],
  gold: ["#fcd34d", "#d97706"],
  amethyst: ["#c084fc", "#7e22ce"],
  sapphire: ["#60a5fa", "#1d4ed8"],
  ruby: ["#f87171", "#b91c1c"],
  iron_ingot: ["#d1d5db", "#6b7280"],
  reinforce_stone: ["#a3e635", "#4d7c0f"],
  refined_crystal: ["#e9d5ff", "#a855f7"],
};

export function ItemIcon({ id, size = 28 }: { id: ItemId | string; size?: number }) {
  const [light, dark] = COLORS[id] ?? ["#9a7350", "#5c3a26"];
  const ingot = id === "iron_ingot";
  const gem = id === "amethyst" || id === "sapphire" || id === "ruby" || id === "refined_crystal";
  return (
    <svg viewBox="0 0 8 8" width={size} height={size} className="pixelated shrink-0" aria-hidden="true">
      {ingot ? (
        <>
          <rect x="1" y="3" width="6" height="3" fill={dark} />
          <rect x="2" y="2" width="5" height="2" fill={light} />
        </>
      ) : gem ? (
        <>
          <rect x="3" y="1" width="2" height="1" fill={light} />
          <rect x="2" y="2" width="4" height="3" fill={light} />
          <rect x="3" y="5" width="2" height="2" fill={dark} />
          <rect x="3" y="2" width="1" height="1" fill="#fff" opacity="0.7" />
        </>
      ) : (
        <>
          <rect x="1" y="2" width="6" height="5" fill={dark} />
          <rect x="2" y="1" width="4" height="5" fill={light} />
          <rect x="3" y="2" width="1" height="1" fill="#fff" opacity="0.5" />
        </>
      )}
    </svg>
  );
}

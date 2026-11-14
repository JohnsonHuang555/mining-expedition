"use client";

import type { BlockPrediction } from "@mining/game-engine";

/** 像素風洞穴場景（SVG，crispEdges）。只做呈現：礦石種類在伺服器結算前一律顯示為未知（TECHNICAL_SPEC §12.2）。 */
const ZONE_PALETTE = [
  { wall: "#5c3a26", rock: "#7a5639", light: "#9a7350", accent: "#f59e0b" },
  { wall: "#33284d", rock: "#4c3d70", light: "#6d5aa0", accent: "#a78bfa" },
  { wall: "#4a3a1c", rock: "#6e5626", light: "#977a3a", accent: "#fcd34d" },
];

export function MiningScene({ zone, prediction }: { zone: number; prediction: BlockPrediction | null }) {
  const p = ZONE_PALETTE[zone] ?? ZONE_PALETTE[0]!;
  const mining = prediction?.status === "mining";
  const crack = mining ? Math.floor((prediction?.progress ?? 0) * 4) : 0;
  return (
    <svg viewBox="0 0 96 48" className="pixelated block h-auto w-full" role="img" aria-label={mining ? "礦工正在挖掘" : "礦工停止挖掘"}>
      <rect width="96" height="48" fill="#140b07" />
      {/* 洞穴牆面磚塊 */}
      {Array.from({ length: 6 }, (_, row) =>
        Array.from({ length: 12 }, (_, col) => (
          <rect key={`${row}-${col}`} x={col * 8 + (row % 2) * 4 - 4} y={row * 6} width="7" height="5" fill={(row + col) % 3 === 0 ? p.rock : p.wall} />
        )),
      )}
      {/* 地面 */}
      <rect y="38" width="96" height="10" fill="#21130c" />
      <rect y="38" width="96" height="1" fill={p.light} />
      {/* 火把 */}
      <rect x="10" y="20" width="2" height="8" fill="#5c3a26" />
      <rect x="9" y="17" width="4" height="3" fill="#ea580c" className="animate-glint" />
      <rect x="10" y="16" width="2" height="2" fill="#fcd34d" />
      {/* 目標方塊（礦石未知：?） */}
      <g transform="translate(58 22)">
        <rect width="16" height="16" fill={p.rock} />
        <rect width="16" height="2" fill={p.light} />
        <rect y="14" width="16" height="2" fill="#000" opacity="0.4" />
        {crack >= 1 && <rect x="7" y="2" width="1" height="5" fill="#000" />}
        {crack >= 2 && <rect x="4" y="7" width="5" height="1" fill="#000" />}
        {crack >= 3 && <rect x="9" y="8" width="1" height="6" fill="#000" />}
        <text x="8" y="11.5" textAnchor="middle" fontSize="7" fontFamily="monospace" fill={p.accent} className={mining ? "animate-glint" : ""}>
          ?
        </text>
      </g>
      {/* 礦工 */}
      <g transform="translate(40 22)">
        <rect x="3" y="0" width="6" height="3" fill="#fcd34d" />
        <rect x="2" y="2" width="8" height="1" fill="#f59e0b" />
        <rect x="4" y="3" width="4" height="4" fill="#f3e2bf" />
        <rect x="6" y="4" width="1" height="1" fill="#140b07" />
        <rect x="3" y="7" width="6" height="5" fill="#2563eb" />
        <rect x="3" y="12" width="2" height="4" fill="#43281a" />
        <rect x="7" y="12" width="2" height="4" fill="#43281a" />
        <g className={mining ? "animate-swing" : ""} style={{ transformBox: "fill-box" }}>
          <rect x="9" y="5" width="1" height="8" fill="#9a7350" />
          <rect x="7" y="4" width="6" height="2" fill="#c9d1d9" />
        </g>
      </g>
      {mining && (
        <g>
          <rect x="56" y="30" width="1" height="1" fill={p.light} className="animate-chip" style={{ ["--dx" as string]: "-6px" }} />
          <rect x="57" y="27" width="1" height="1" fill={p.accent} className="animate-chip" style={{ ["--dx" as string]: "-4px", animationDelay: "0.2s" }} />
        </g>
      )}
      {!mining && prediction && prediction.status !== "paused" && <rect x="58" y="22" width="16" height="16" fill="#000" opacity="0.35" />}
    </svg>
  );
}

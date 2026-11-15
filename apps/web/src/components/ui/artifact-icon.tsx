import type { ArtifactId } from "@mining/game-data";

/**
 * 像素風寶物圖示（不使用外部美術資產）。每件寶物一個簡單的造型；未發現時以剪影顯示（不透露顏色與細節）。
 */
type Shape = "lantern" | "badge" | "map" | "heart" | "orb" | "crown" | "mural" | "emblem" | "ring" | "tablet";
const SHAPE: Record<ArtifactId, Shape> = {
  a_z1_lantern: "lantern",
  a_z1_badge: "badge",
  a_z1_map: "map",
  a_z1_heart: "heart",
  a_z2_orb: "orb",
  a_z2_crown: "crown",
  a_z2_mural: "mural",
  a_z2_heart: "heart",
  a_z3_emblem: "emblem",
  a_z3_ring: "ring",
  a_z3_tablet: "tablet",
  a_z3_crown: "crown",
};
const ZONE_COLORS: [string, string][] = [
  ["#f59e0b", "#92400e"],
  ["#c4b5fd", "#6d28d9"],
  ["#fcd34d", "#a16207"],
];

const PIXELS: Record<Shape, string[]> = {
  // 8×8：L = 亮色、D = 暗色、. = 透明
  lantern: ["..DDDD..", "...DD...", "..DLLD..", ".DLLLLD.", ".DLLLLD.", ".DLLLLD.", "..DDDD..", "...DD..."],
  badge: ["...DD...", "..DLLD..", ".DLLLLD.", "DLLDDLLD", "DLLDDLLD", ".DLLLLD.", "..DLLD..", "...DD..."],
  map: ["DDDDDDDD", "DLLLLDLD", "DLDLLLLD", "DLLLDLLD", "DLDLLLLD", "DLLLLDLD", "DLLLLLLD", "DDDDDDDD"],
  heart: [".DD..DD.", "DLLDDLLD", "DLLLLLLD", "DLLLLLLD", ".DLLLLD.", "..DLLD..", "...DD...", "........"],
  orb: ["..DDDD..", ".DLLLLD.", "DLLDLLLD", "DLLLLLLD", "DLLLLLLD", ".DLLLLD.", "..DDDD..", ".DDDDDD."],
  crown: ["........", "D..D..D.", "DD.DD.DD", "DLDLLDLD", "DLLLLLLD", "DLLLLLLD", "DDDDDDDD", "........"],
  mural: ["DDDDDDDD", "DLLLLLLD", "DLDLLDLD", "DLLDDLLD", "DLDLLDLD", "DLLLLLLD", "DDDDDDDD", "........"],
  emblem: ["..DDDD..", ".DLLLLD.", "DLLDDLLD", "DLDLLDLD", "DLDLLDLD", "DLLDDLLD", ".DLLLLD.", "..DDDD.."],
  ring: ["...LL...", "..LDDL..", "..DDDD..", ".D....D.", "D......D", "D......D", ".D....D.", "..DDDD.."],
  tablet: [".DDDDDD.", "DLLLLLLD", "DLDDLLLD", "DLLLLDLD", "DLDLLLLD", "DLLLDDLD", "DLLLLLLD", ".DDDDDD."],
};

export function ArtifactIcon({ id, discovered, zone, legendary, size = 40 }: { id: ArtifactId; discovered: boolean; zone: number; legendary: boolean; size?: number }) {
  const [light, dark] = discovered ? (legendary ? ["#fde68a", "#b45309"] : (ZONE_COLORS[zone] ?? ZONE_COLORS[0]!)) : ["#4a2e1e", "#4a2e1e"];
  const rows = PIXELS[SHAPE[id]];
  return (
    <svg viewBox="-1 -1 10 10" width={size} height={size} className="pixelated shrink-0" aria-hidden="true" data-artifact={id} data-silhouette={!discovered || undefined} data-legendary={discovered && legendary ? "true" : undefined}>
      {discovered && legendary && <rect x="-1" y="-1" width="10" height="10" fill="#fcd34d" opacity="0.15" />}
      {rows.flatMap((row, y) =>
        [...row].map((c, x) => (c === "." ? null : <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={c === "L" ? light : dark} opacity={discovered ? 1 : 0.85} />)),
      )}
      {!discovered && (
        <text x="4" y="5.8" textAnchor="middle" fontSize="4" fontFamily="monospace" fill="#c9b38c">
          ?
        </text>
      )}
    </svg>
  );
}

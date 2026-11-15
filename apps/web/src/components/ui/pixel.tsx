import type { ComponentPropsWithRef, ReactNode } from "react";

export function Panel({ title, children, className = "", right }: { title?: ReactNode; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <section className={`pixel-frame p-3 sm:p-4 ${className}`}>
      {title !== undefined && (
        <header className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold tracking-wider text-ember uppercase">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

const TONES = {
  primary: "bg-ember text-cave-950 hover:bg-gold",
  secondary: "bg-cave-600 text-parchment hover:bg-rock-500",
  danger: "bg-lava text-cave-950 hover:bg-ember",
  ghost: "bg-cave-700 text-parchment-dim hover:text-parchment",
} as const;

export function PixelButton({ tone = "primary", className = "", ...rest }: ComponentPropsWithRef<"button"> & { tone?: keyof typeof TONES }) {
  return <button type="button" {...rest} className={`pixel-btn px-4 py-2 text-sm ${TONES[tone]} ${className}`} />;
}

/** 分格像素進度條（10 格 × 每格 10%） */
export function PixelBar({ value, label, tone = "ember" }: { value: number; label: string; tone?: "ember" | "crystal" | "moss" }) {
  const pct = Math.max(0, Math.min(1, value));
  const color = tone === "crystal" ? "bg-crystal" : tone === "moss" ? "bg-moss" : "bg-ember";
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} className="relative h-6 w-full bg-cave-950 p-1 shadow-[0_0_0_3px_#000]">
      <div className={`h-full ${color} transition-[width] duration-200 ease-linear`} style={{ width: `${pct * 100}%` }} />
      <div className="pointer-events-none absolute inset-1 grid grid-cols-10">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className="border-r-2 border-cave-950/70 last:border-r-0" />
        ))}
      </div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] tracking-wider text-parchment-dim">{label}</div>
      <div className="truncate font-mono text-base font-bold text-parchment sm:text-lg" title={hint}>
        {value}
      </div>
    </div>
  );
}

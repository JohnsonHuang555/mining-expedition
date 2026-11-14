import { createElement } from "react";
import { afterEach, vi } from "vitest";

// 元件測試不在 Next.js App Router 中執行：Link 以 <a> 代替，路徑固定為 /
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

// jsdom 的元件測試：每個測試後卸載
afterEach(async () => {
  if (typeof document !== "undefined") {
    const { cleanup } = await import("@testing-library/react");
    cleanup();
  }
});

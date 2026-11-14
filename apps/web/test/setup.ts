import { afterEach } from "vitest";

// jsdom 的元件測試：每個測試後卸載
afterEach(async () => {
  if (typeof document !== "undefined") {
    const { cleanup } = await import("@testing-library/react");
    cleanup();
  }
});

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {} }) }));
vi.mock("@/lib/auth/auth-provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/auth-provider")>()),
  useAuth: () => ({ status: "signed_out", signIn: async () => null, signUp: async () => null, signOut: async () => {} }),
}));

const { LoginForm, signupEnabled } = await import("@/components/auth/LoginForm");
const { authMessage } = await import("@/lib/auth/auth-provider");

describe("封閉測試的登入畫面", () => {
  it("NEXT_PUBLIC_SIGNUP_ENABLED=false：只顯示登入，說明封閉測試", () => {
    expect(signupEnabled("false")).toBe(false);
    expect(signupEnabled(undefined)).toBe(true);
    expect(signupEnabled("true")).toBe(true);
    render(<LoginForm allowSignup={false} />);
    expect(screen.getByTestId("signup-closed")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "註冊" })).toBeNull();
    expect(screen.getByRole("tab", { name: "登入" })).toBeTruthy();
  });

  it("本地 / 未設定：登入與註冊都顯示", () => {
    render(<LoginForm allowSignup />);
    expect(screen.getAllByRole("tab", { name: "註冊" })).toHaveLength(1);
  });

  it("Supabase Auth 關閉註冊時的錯誤訊息", () => {
    expect(authMessage("signup_disabled", "x")).toContain("封閉測試");
  });
});

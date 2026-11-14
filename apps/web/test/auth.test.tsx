// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type Listener = (event: string, session: unknown) => void;

function fakeSupabase(initial: unknown) {
  let listener: Listener | null = null;
  const client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: initial } })),
      onAuthStateChange: vi.fn((fn: Listener) => {
        listener = fn;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      signInWithPassword: vi.fn(async ({ password }: { password: string }) =>
        password === "right-password" ? { data: {}, error: null } : { data: {}, error: { code: "invalid_credentials" } },
      ),
      signUp: vi.fn(async () => ({ data: { session: null }, error: { code: "user_already_exists" } })),
      signOut: vi.fn(async () => listener?.("SIGNED_OUT", null)),
    },
  };
  return { client, emit: (e: string, s: unknown) => listener?.(e, s) };
}

async function loadProvider(initial: unknown) {
  vi.resetModules();
  const fake = fakeSupabase(initial);
  vi.doMock("@/lib/auth/supabase", () => ({ getSupabase: () => fake.client, publicSupabaseEnv: () => ({ url: "http://x", anonKey: "anon" }) }));
  const mod = await import("@/lib/auth/auth-provider");
  function Probe() {
    const a = mod.useAuth();
    return <p data-testid="auth">{`${a.status}:${a.userId ?? "-"}`}</p>;
  }
  return { ...mod, fake, Probe };
}

describe("Auth", () => {
  it("Session 自動恢復：重新開啟頁面時從保存的 session 直接登入", async () => {
    const { AuthProvider, Probe } = await loadProvider({ user: { id: "u1", email: "a@b.c" }, access_token: "t" });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("auth").textContent).toBe("loading:-");
    await act(async () => {});
    expect(screen.getByTestId("auth").textContent).toBe("signed_in:u1");
  });

  it("沒有 session → signed_out；session 失效事件（token 更新失敗 / 登出）→ signed_out", async () => {
    const { AuthProvider, Probe, fake } = await loadProvider(null);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await act(async () => {});
    expect(screen.getByTestId("auth").textContent).toBe("signed_out:-");
    await act(async () => fake.emit("SIGNED_IN", { user: { id: "u2" } }));
    expect(screen.getByTestId("auth").textContent).toBe("signed_in:u2");
    await act(async () => fake.emit("SIGNED_OUT", null));
    expect(screen.getByTestId("auth").textContent).toBe("signed_out:-");
  });

  it("登入 / 註冊錯誤轉成玩家看得懂的訊息（不顯示內部細節）", async () => {
    const { authMessage } = await loadProvider(null);
    expect(authMessage("invalid_credentials", "x")).toBe("Email 或密碼錯誤");
    expect(authMessage("user_already_exists", "x")).toBe("這個 Email 已經註冊，請直接登入");
    expect(authMessage("something_internal", "登入失敗，請稍後再試")).toBe("登入失敗，請稍後再試");
  });
});

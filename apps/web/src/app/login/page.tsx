import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";

export const metadata: Metadata = { title: "登入｜挖礦探險隊" };

export default function LoginPage() {
  return <LoginForm />;
}

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

describe("外部依賴版本一致（TECHNICAL_SPEC §3.4、T4）", () => {
  it("@noble/hashes：Node（package.json）與所有 Deno import map 是同一個固定版本", () => {
    const nodeVersion: string = json("../package.json").dependencies["@noble/hashes"];
    expect(nodeVersion).toMatch(/^\d+\.\d+\.\d+$/); // 固定版本，不用 ^ / ~
    for (const cfg of ["../deno.test.json", "../../../supabase/functions/health/deno.json"]) {
      const imports: Record<string, string> = json(cfg).imports;
      for (const sub of ["hmac.js", "sha2.js"]) {
        expect(imports[`@noble/hashes/${sub}`], `${cfg} ${sub}`).toBe(`npm:@noble/hashes@${nodeVersion}/${sub}`);
      }
    }
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeGolden } from "./golden.ts";

describe("確定性快照（RNG_VERSION 1）", () => {
  it("與 fixtures/golden-v1.json 完全相同（Deno 端由 CI 比對同一份 fixture）", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/golden-v1.json", import.meta.url), "utf8"));
    expect(JSON.parse(JSON.stringify(computeGolden()))).toEqual(fixture);
  });
});

/** 輸出確定性快照 JSON（Node 與 Deno 共用；CI 比對兩者與 fixture） */
import { computeGolden } from "./golden.ts";

console.log(JSON.stringify(computeGolden(), null, 2));

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTarget } from "./guard.ts";

const ref = "abcdefghijklmnopqrst";
const prod = "zyxwvutsrqponmlkjihg";

test("通過：ref 合法、確認相同、不是 production、已連結同一個專案", () => {
  assert.deepEqual(checkTarget({ stagingRef: ref, confirmRef: ref, productionRefs: prod, linkedRef: `${ref}\n` }), []);
  assert.deepEqual(checkTarget({ stagingRef: ref, confirmRef: ref, productionRefs: undefined, linkedRef: null }), []);
});

test("拒絕：缺少 / 格式錯誤 / 確認不同 / 等於 production / 連結到別的專案", () => {
  assert.equal(checkTarget({ stagingRef: undefined, confirmRef: undefined, productionRefs: undefined, linkedRef: null }).length > 0, true);
  assert.match(checkTarget({ stagingRef: "ABC", confirmRef: "ABC", productionRefs: undefined, linkedRef: null })[0]!, /not a valid/);
  assert.match(checkTarget({ stagingRef: ref, confirmRef: prod, productionRefs: undefined, linkedRef: null })[0]!, /does not match/);
  assert.match(checkTarget({ stagingRef: prod, confirmRef: prod, productionRefs: `${ref}, ${prod}`, linkedRef: null })[0]!, /production/);
  assert.match(checkTarget({ stagingRef: ref, confirmRef: ref, productionRefs: undefined, linkedRef: prod })[0]!, /linked/);
});

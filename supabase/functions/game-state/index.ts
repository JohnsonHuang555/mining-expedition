// GET /functions/v1/game-state — 讀取自己的公開遊戲狀態（唯讀：不結算、不改變任何資料）
//
// 要把時間推進到現在（可能產生離線報告），用 game-action 的 { "type": "settle" }。

import { readState } from "@mining/game-server";
import { authenticate, errorResponse, gameDb, log, respond, serve } from "../_shared/api.ts";

serve(["GET"], async (req, timing) => {
  const userId = await authenticate(req, timing);
  if (userId instanceof Response) return userId;
  if (new URL(req.url).searchParams.size > 0) return errorResponse(400, "INVALID_REQUEST", "game-state takes no parameters");
  return respond(await readState(gameDb(timing), userId, { log }), timing);
});

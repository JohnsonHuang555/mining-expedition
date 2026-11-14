// POST /functions/v1/character-create — 建立初始角色（TECHNICAL_SPEC §10.2）
//
// 玩家身分 = 已驗證 JWT 的使用者 id。初始狀態由引擎產生，時間與 RNG 密鑰由資料庫決定。
// 已存在時回傳 409 CHARACTER_EXISTS 與目前狀態（不覆寫；重送安全）。

import { createCharacter } from "@mining/game-server";
import { authenticate, errorResponse, gameDb, log, readJson, respond, serve } from "../_shared/api.ts";

serve(["POST"], async (req, timing) => {
  const userId = await authenticate(req, timing);
  if (userId instanceof Response) return userId;
  const body = await readJson(req);
  if (body instanceof Response) return body;
  if (Object.keys(body).length > 0) return errorResponse(400, "INVALID_REQUEST", "character-create takes no parameters");
  const response = await createCharacter(gameDb(timing), userId, { log });
  return respond(response, timing, {}, response.ok ? 201 : undefined);
});

// POST /functions/v1/game-action — 結算與所有玩家操作（含領取離線報告）
//
//   Authorization: Bearer <使用者 JWT>
//   Idempotency-Key: <uuid>（重試時沿用同一個）
//   { "command": { "type": "settle" } }
//   { "command": { "type": "purchase_pickaxe", "pickaxeId": "pick_stone" } }
//   { "command": { "type": "claim_report", "reportId": "r1700000000000" } }
//
// 流程（TECHNICAL_SPEC §10.4）：驗證 JWT → playerId → 驗證 body 與 key → game_load_snapshot →
// executeRequest → game_commit（CAS，衝突時以同一個 key 重試最多 3 次）。

import { handleGameRequest } from "@mining/game-server";
import { authenticate, errorResponse, gameDb, log, readJson, respond, serve } from "../_shared/api.ts";

serve(["POST"], async (req, timing) => {
  const userId = await authenticate(req, timing);
  if (userId instanceof Response) return userId;
  const key = req.headers.get("Idempotency-Key");
  if (!key) return errorResponse(400, "INVALID_REQUEST", "Idempotency-Key header is required");
  const body = await readJson(req);
  if (body instanceof Response) return body;
  // 只接受 { command }：不接受 playerId、時間、價格、成本等任何其他欄位
  if (Object.keys(body).length !== 1 || !("command" in body)) {
    return errorResponse(400, "INVALID_REQUEST", "body must be { command } only");
  }
  const r = await handleGameRequest(gameDb(timing), { playerId: userId, requestId: key, command: body.command }, { log });
  return respond(r.response, timing, r);
});

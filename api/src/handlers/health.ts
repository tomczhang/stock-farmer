import type { Context } from "hono";
import type { Env, HealthResponse } from "../types";

/**
 * GET /api/health
 *
 * 永远返回 status=ok（只要 Workers 在跑就能命中），
 * 同时把最近一次 pipeline 拉数据的时间戳带回去，方便外部监控判断"数据是否新鲜"。
 */
export async function getHealth(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const row = await c.env.DB.prepare(
    "SELECT MAX(last_fetched_at) AS last_run FROM fetch_log WHERE data_type IN ('prices', 'eps', 'pe_series')",
  ).first<{ last_run: string | null }>();

  const body: HealthResponse = {
    status: "ok",
    last_pipeline_run: row?.last_run ?? null,
  };

  return c.json(body, 200);
}

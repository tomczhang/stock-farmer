import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetAndSeed, resetSchema } from "./setup";
import type { HealthResponse } from "../types";

beforeEach(async () => {
  await resetAndSeed();
});

describe("GET /api/health", () => {
  it("returns status=ok and last_pipeline_run from fetch_log", async () => {
    const res = await SELF.fetch("https://api.test/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe("ok");
    expect(body.last_pipeline_run).toBe("2026-05-21T08:00:00Z");
  });

  it("returns last_pipeline_run=null when fetch_log empty", async () => {
    await resetSchema(); // no seed → fetch_log empty
    const res = await SELF.fetch("https://api.test/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe("ok");
    expect(body.last_pipeline_run).toBeNull();
  });
});

import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetAndSeed } from "./setup";

beforeEach(async () => {
  await resetAndSeed();
});

describe("CORS", () => {
  it("echoes allowed origin on simple GET", async () => {
    const res = await SELF.fetch("https://api.test/api/health", {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173",
    );
    const vary = res.headers.get("Vary") ?? "";
    expect(vary).toContain("Origin");
  });

  it("does not set CORS header for disallowed origin", async () => {
    const res = await SELF.fetch("https://api.test/api/health", {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("handles OPTIONS preflight with 204 + allow headers", async () => {
    const res = await SELF.fetch("https://api.test/api/watchlist", {
      method: "OPTIONS",
      headers: {
        Origin: "https://stock-farmer.pages.dev",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://stock-farmer.pages.dev",
    );
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "Content-Type",
    );
  });

  it("OPTIONS preflight from disallowed origin returns 204 without CORS headers", async () => {
    const res = await SELF.fetch("https://api.test/api/watchlist", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });
});

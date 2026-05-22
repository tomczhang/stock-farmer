import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * vitest 配置：用 `@cloudflare/vitest-pool-workers` 把测试跑在真实的 Workers runtime（workerd）里。
 *
 * - `singleWorker: true`：所有测试共享一个 worker 实例，但每个测试文件会拿到隔离的 D1 副本（`isolatedStorage: true`）。
 * - `miniflare.d1Databases.DB`：声明一个内存 D1，binding 名 `DB` 与 wrangler.toml 对齐。
 * - `miniflare.bindings.ALLOWED_ORIGINS`：在测试里覆盖 CORS 白名单。
 *
 * schema 由 `src/__tests__/setup.ts` 的 `seed()` helper 在每个测试 beforeEach 时建好。
 */
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: true,
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2025-05-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { DB: "stock-farmer-test" },
          bindings: {
            ALLOWED_ORIGINS:
              "http://localhost:5173,https://stock-farmer.pages.dev",
          },
        },
      },
    },
  },
});

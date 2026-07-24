export interface AppConfig {
  dbPath: string;
  port: number;
  sessionSecret: string;
  resendApiKey: string;
  mailFrom: string;
  staticDir: string;
  /** 即期汇率：1 单位货币兑多少 USD。可用 FX_HKD_USD / FX_CNY_USD 覆盖。 */
  fxToUsd: Record<string, number>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    dbPath: env.DB_PATH ?? "./data/portfolio.db",
    port: Number(env.PORT ?? 8790),
    sessionSecret: env.SESSION_SECRET ?? "dev-secret-change-me",
    resendApiKey: env.RESEND_API_KEY ?? "",
    mailFrom: env.MAIL_FROM ?? "Stock Farmer <noreply@example.com>",
    staticDir: env.STATIC_DIR ?? "./public",
    fxToUsd: {
      USD: 1,
      HKD: Number(env.FX_HKD_USD ?? 0.1282),
      CNY: Number(env.FX_CNY_USD ?? 0.1395),
    },
  };
}

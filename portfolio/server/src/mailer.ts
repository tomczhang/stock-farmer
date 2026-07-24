export interface Mailer {
  sendCode(to: string, code: string): Promise<void>;
}

/** Resend HTTP API；未配置 API key 时降级为控制台输出（本地开发）。 */
export function createMailer(apiKey: string, from: string): Mailer {
  if (!apiKey) {
    return {
      async sendCode(to, code) {
        console.log(`[mail:dev] 验证码 ${code} -> ${to}（未配置 RESEND_API_KEY，仅打印）`);
      },
    };
  }
  return {
    async sendCode(to, code) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject: `Stock Farmer 验证码：${code}`,
          html: [
            '<div style="font-family:-apple-system,sans-serif;max-width:420px;margin:0 auto;padding:24px">',
            '<h2 style="color:#0f172a;margin:0 0 8px">价值观察站</h2>',
            '<p style="color:#475569">你的邮箱验证码是：</p>',
            `<div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#eab308;padding:16px 0">${code}</div>`,
            '<p style="color:#94a3b8;font-size:13px">验证码 10 分钟内有效。如果不是你本人操作，请忽略本邮件。</p>',
            "</div>",
          ].join(""),
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Resend 发信失败 (${res.status}): ${detail.slice(0, 200)}`);
      }
    },
  };
}

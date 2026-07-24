import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type { AppDatabase } from "./db.js";
import type { Mailer } from "./mailer.js";

const CODE_TTL_MINUTES = 10;
const CODE_RESEND_SECONDS = 60;
const CODE_DAILY_LIMIT = 10;
const CODE_MAX_ATTEMPTS = 5;
const SESSION_TTL_DAYS = 30;

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeEmail(email: string) {
  const value = String(email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new AuthError("邮箱格式不正确", 400);
  }
  return value;
}

export interface AuthService {
  register(email: string, password: string): Promise<void>;
  resendCode(email: string): Promise<void>;
  verify(email: string, code: string): void;
  login(email: string, password: string): string;
  logout(token: string): void;
  userIdForToken(token: string): number | null;
  userEmail(userId: number): string | null;
}

export function createAuthService(db: AppDatabase, mailer: Mailer): AuthService {
  async function issueCode(email: string) {
    const recent = db
      .prepare(
        "SELECT created_at FROM auth_codes WHERE email = ? AND created_at > datetime('now', ?) LIMIT 1",
      )
      .get(email, `-${CODE_RESEND_SECONDS} seconds`);
    if (recent) {
      throw new AuthError("验证码发送过于频繁，请 60 秒后再试", 429);
    }
    const daily = db
      .prepare(
        "SELECT COUNT(*) AS n FROM auth_codes WHERE email = ? AND created_at > datetime('now', '-1 day')",
      )
      .get(email) as { n: number };
    if (daily.n >= CODE_DAILY_LIMIT) {
      throw new AuthError("今日验证码次数已达上限，请明天再试", 429);
    }
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    db.prepare(
      "INSERT INTO auth_codes (email, code_hash, purpose, expires_at) VALUES (?, ?, 'register', datetime('now', ?))",
    ).run(email, sha256(code), `+${CODE_TTL_MINUTES} minutes`);
    await mailer.sendCode(email, code);
  }

  return {
    async register(rawEmail, password) {
      const email = normalizeEmail(rawEmail);
      if (String(password ?? "").length < 8) {
        throw new AuthError("密码至少 8 位", 400);
      }
      const existing = db
        .prepare("SELECT id, verified_at FROM users WHERE email = ?")
        .get(email) as { id: number; verified_at: string | null } | undefined;
      if (existing?.verified_at) {
        throw new AuthError("该邮箱已注册，请直接登录", 409);
      }
      const passwordHash = bcrypt.hashSync(password, 10);
      if (existing) {
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, existing.id);
      } else {
        db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email, passwordHash);
      }
      await issueCode(email);
    },

    async resendCode(rawEmail) {
      const email = normalizeEmail(rawEmail);
      const user = db.prepare("SELECT id, verified_at FROM users WHERE email = ?").get(email) as
        | { id: number; verified_at: string | null }
        | undefined;
      if (!user) throw new AuthError("该邮箱尚未注册", 404);
      if (user.verified_at) throw new AuthError("该邮箱已验证，请直接登录", 409);
      await issueCode(email);
    },

    verify(rawEmail, code) {
      const email = normalizeEmail(rawEmail);
      const record = db
        .prepare(
          "SELECT id, code_hash, attempts FROM auth_codes WHERE email = ? AND consumed_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1",
        )
        .get(email) as { id: number; code_hash: string; attempts: number } | undefined;
      if (!record) {
        throw new AuthError("验证码不存在或已过期，请重新获取", 400);
      }
      if (record.attempts >= CODE_MAX_ATTEMPTS) {
        throw new AuthError("验证码错误次数过多，请重新获取", 400);
      }
      if (record.code_hash !== sha256(String(code ?? "").trim())) {
        db.prepare("UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?").run(record.id);
        throw new AuthError("验证码错误", 400);
      }
      db.prepare("UPDATE auth_codes SET consumed_at = datetime('now') WHERE id = ?").run(record.id);
      db.prepare("UPDATE users SET verified_at = datetime('now') WHERE email = ?").run(email);
    },

    login(rawEmail, password) {
      const email = normalizeEmail(rawEmail);
      const user = db
        .prepare("SELECT id, password_hash, verified_at FROM users WHERE email = ?")
        .get(email) as { id: number; password_hash: string; verified_at: string | null } | undefined;
      if (!user || !bcrypt.compareSync(String(password ?? ""), user.password_hash)) {
        throw new AuthError("邮箱或密码错误", 401);
      }
      if (!user.verified_at) {
        throw new AuthError("邮箱尚未验证，请先完成验证码验证", 403);
      }
      const token = crypto.randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))",
      ).run(sha256(token), user.id, `+${SESSION_TTL_DAYS} days`);
      return token;
    },

    logout(token) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    },

    userIdForToken(token) {
      if (!token) return null;
      const row = db
        .prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')")
        .get(sha256(token)) as { user_id: number } | undefined;
      return row?.user_id ?? null;
    },

    userEmail(userId) {
      const row = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as
        | { email: string }
        | undefined;
      return row?.email ?? null;
    },
  };
}

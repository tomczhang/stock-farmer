import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useAuth } from "../App";

type Mode = "login" | "register" | "verify";

export default function LoginPage() {
  const { me, loading, refresh } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (!loading && me) return <Navigate to="/" replace />;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "请求失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  };

  const submitLogin = () =>
    run(async () => {
      await api.post("/api/auth/login", { email, password });
      await refresh();
      navigate("/");
    });

  const submitRegister = () =>
    run(async () => {
      await api.post("/api/auth/register", { email, password });
      setMode("verify");
      setNotice("验证码已发送至邮箱，请查收（10 分钟内有效）");
    });

  const submitVerify = () =>
    run(async () => {
      await api.post("/api/auth/verify", { email, code });
      setMode("login");
      setNotice("邮箱验证成功，请登录");
    });

  const resend = () =>
    run(async () => {
      await api.post("/api/auth/resend", { email });
      setNotice("验证码已重新发送");
    });

  return (
    <div className="auth-wrap">
      <div className="auth-card fade-in">
        <div className="brand">
          <span className="dot" />
          <h1>价值观察站</h1>
        </div>
        <p className="sub">上传券商月结单，盘点仓位现金比，制定金字塔加仓计划</p>

        {mode !== "verify" && (
          <div className="auth-tabs">
            <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
              登录
            </button>
            <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>
              注册
            </button>
          </div>
        )}

        {error && <div className="alert error">{error}</div>}
        {notice && <div className="alert ok">{notice}</div>}

        {mode === "verify" ? (
          <>
            <div className="field">
              <label>邮箱验证码</label>
              <input
                className="input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="6 位数字验证码"
                maxLength={6}
                autoFocus
              />
            </div>
            <button className="btn" style={{ width: "100%" }} disabled={busy || code.length !== 6} onClick={submitVerify}>
              {busy ? <span className="spin" /> : "验证邮箱"}
            </button>
            <button className="btn ghost sm" style={{ width: "100%", marginTop: 10 }} disabled={busy} onClick={resend}>
              重新发送验证码
            </button>
          </>
        ) : (
          <>
            <div className="field">
              <label>邮箱</label>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoFocus
              />
            </div>
            <div className="field">
              <label>密码{mode === "register" ? "（至少 8 位）" : ""}</label>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                onKeyDown={(e) => {
                  if (e.key === "Enter") (mode === "login" ? submitLogin : submitRegister)();
                }}
              />
            </div>
            <button
              className="btn"
              style={{ width: "100%", marginTop: 6 }}
              disabled={busy || !email || !password}
              onClick={mode === "login" ? submitLogin : submitRegister}
            >
              {busy ? <span className="spin" /> : mode === "login" ? "登录" : "注册并发送验证码"}
            </button>
            {mode === "register" && (
              <p style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 12, lineHeight: 1.6 }}>
                注册后需要通过邮箱验证码完成验证。你的月结单只在浏览器本地解析，原始文件与 PDF 密码不会上传到服务器。
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

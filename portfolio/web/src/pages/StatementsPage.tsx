import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { fmtMoney } from "../components/Chart";
import { analyzeStatementFiles, BROKERS, type BrokerId } from "../lib/parse/analyze";
import type { StatementRow } from "../types";

interface PreviewPosition {
  market: string;
  currency: string;
  symbol: string;
  name: string;
  quantity: number;
  marketValue: number;
  costBasis: number | null;
  unrealizedGl: number | null;
}

interface PreviewCash {
  currency: string;
  amount: string;
  fromParse: boolean;
}

export default function StatementsPage() {
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [listBusy, setListBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 上传向导状态
  const [broker, setBroker] = useState<BrokerId | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [password, setPassword] = useState("");
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState<{
    positions: PreviewPosition[];
    cash: PreviewCash[];
    asOf: string;
    issues: Array<{ severity: string; title: string; detail: string }>;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const brokerMeta = useMemo(() => BROKERS.find((b) => b.id === broker), [broker]);
  const step = preview ? 3 : files.length > 0 ? 2 : broker ? 2 : 1;

  const loadList = useCallback(async () => {
    setListBusy(true);
    try {
      setStatements(await api.get<StatementRow[]>("/api/statements"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载失败");
    } finally {
      setListBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const resetWizard = () => {
    setFiles([]);
    setPassword("");
    setPreview(null);
  };

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    setPreview(null);
    setFiles((prev) => {
      const merged = [...prev];
      for (const file of Array.from(incoming)) {
        if (!merged.some((f) => f.name === file.name && f.size === file.size)) merged.push(file);
      }
      return merged;
    });
  };

  const parse = async () => {
    if (!broker) return;
    setParsing(true);
    setError("");
    setNotice("");
    try {
      const result = await analyzeStatementFiles({ broker, files, password: password || undefined });
      if (result.positions.length === 0) {
        setNotice("解析完成，但未在文件中找到持仓记录（可能是纯交易流水报表）。仍可手动确认现金后保存。");
      }
      setPreview({
        positions: result.positions.map((p) => ({
          market: p.market,
          currency: p.currency,
          symbol: p.symbol,
          name: p.securityName,
          quantity: p.quantity,
          marketValue: p.marketValue,
          costBasis: p.costBasis ?? null,
          unrealizedGl: p.unrealizedGainLoss ?? null,
        })),
        cash:
          result.cashBalances.length > 0
            ? result.cashBalances.map((c) => ({ currency: c.currency, amount: String(c.amount), fromParse: true }))
            : [{ currency: "USD", amount: "", fromParse: false }],
        asOf: result.asOf,
        issues: result.issues.filter((issue) => issue.severity !== "info").slice(0, 5),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "解析失败");
    } finally {
      setParsing(false);
    }
  };

  const save = async () => {
    if (!broker || !preview) return;
    setSaving(true);
    setError("");
    try {
      await api.post("/api/statements", {
        broker,
        fileName: files.map((f) => f.name).join(", "),
        asOf: preview.asOf,
        positions: preview.positions.map((p) => ({ ...p, broker })),
        cashBalances: preview.cash
          .filter((c) => c.amount !== "" && Number.isFinite(Number(c.amount)))
          .map((c) => ({ broker, currency: c.currency, amount: Number(c.amount) })),
      });
      setNotice(`已保存 ${brokerMeta?.label} @ ${preview.asOf} 快照`);
      resetWizard();
      setBroker(null);
      await loadList();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    if (!window.confirm("确定删除该快照？对应的持仓与现金记录将一并删除。")) return;
    try {
      await api.delete(`/api/statements/${id}`);
      await loadList();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  return (
    <div className="fade-in">
      <h1 className="page-title">月结单管理</h1>
      <p className="page-desc">月结单在浏览器本地解析，原始文件与 PDF 密码不会上传到服务器，只保存解析后的持仓与现金快照。</p>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-h">上传向导</div>
        <div className="steps">
          <div className={`step ${step > 1 ? "done" : "active"}`}>1. 选择券商</div>
          <div className={`step ${step === 2 ? "active" : step > 2 ? "done" : ""}`}>2. 上传并解析</div>
          <div className={`step ${step === 3 ? "active" : ""}`}>3. 预览确认</div>
        </div>

        <div className="broker-grid" style={{ marginBottom: 16 }}>
          {BROKERS.map((b) => (
            <div
              key={b.id}
              className={`broker-item ${broker === b.id ? "active" : ""}`}
              onClick={() => {
                setBroker(b.id);
                resetWizard();
              }}
            >
              <div className="name">{b.label}</div>
              <div className="hint">{b.hint}</div>
            </div>
          ))}
        </div>

        {broker && (
          <>
            <div
              className={`dropzone ${drag ? "drag" : ""}`}
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                addFiles(e.dataTransfer.files);
              }}
            >
              {files.length === 0 ? (
                <>
                  点击或拖入 {brokerMeta?.label} 月结单（{brokerMeta?.accept}），可多选
                </>
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                  {files.map((f) => (
                    <span key={f.name} className="chip gray">
                      {f.name}
                      <button
                        className="btn danger sm"
                        style={{ padding: "0 4px", marginLeft: 4 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPreview(null);
                          setFiles((prev) => prev.filter((x) => x.name !== f.name));
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <input
                ref={fileInput}
                type="file"
                accept={brokerMeta?.accept}
                multiple
                hidden
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
              {brokerMeta?.needsPassword && (
                <input
                  className="input"
                  style={{ width: 240 }}
                  type="password"
                  placeholder="PDF 密码（仅在浏览器本地使用）"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
              <button className="btn" disabled={parsing || files.length === 0} onClick={parse}>
                {parsing ? (
                  <>
                    <span className="spin" /> 本地解析中…
                  </>
                ) : (
                  "本地解析"
                )}
              </button>
              {files.length > 0 && (
                <button className="btn ghost" onClick={resetWizard}>
                  重置
                </button>
              )}
            </div>
          </>
        )}

        {preview && (
          <div className="fade-in" style={{ marginTop: 20, borderTop: "1px dashed var(--border)", paddingTop: 18 }}>
            {preview.issues.length > 0 && (
              <div className="alert warn">
                {preview.issues.map((issue) => (
                  <div key={issue.title}>
                    <b>{issue.title}</b>：{issue.detail}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
              <div className="card-h" style={{ margin: 0 }}>
                持仓预览（{preview.positions.length} 条）
              </div>
              <label style={{ fontSize: 12, color: "var(--ink-3)" }}>
                快照日期
                <input
                  className="input sm"
                  style={{ width: 130, marginLeft: 6 }}
                  type="date"
                  value={preview.asOf}
                  onChange={(e) => setPreview({ ...preview, asOf: e.target.value })}
                />
              </label>
            </div>
            <div style={{ maxHeight: 300, overflowY: "auto", marginBottom: 16 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>标的</th>
                    <th>市场</th>
                    <th>币种</th>
                    <th className="num">数量</th>
                    <th className="num">市值</th>
                    <th className="num">成本</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {preview.positions.map((p, i) => (
                    <tr key={`${p.symbol}-${i}`}>
                      <td>
                        <b>{p.symbol}</b>
                        <span style={{ color: "var(--ink-4)", fontSize: 11, marginLeft: 6 }}>{p.name}</span>
                      </td>
                      <td>{p.market}</td>
                      <td>{p.currency}</td>
                      <td className="num">{fmtMoney(p.quantity, 0)}</td>
                      <td className="num">
                        <input
                          className="input sm num"
                          style={{ width: 110, textAlign: "right" }}
                          type="number"
                          value={p.marketValue}
                          onChange={(e) => {
                            const next = [...preview.positions];
                            next[i] = { ...p, marketValue: Number(e.target.value) };
                            setPreview({ ...preview, positions: next });
                          }}
                        />
                      </td>
                      <td className="num">{p.costBasis != null ? fmtMoney(p.costBasis) : "—"}</td>
                      <td>
                        <button
                          className="btn danger sm"
                          onClick={() =>
                            setPreview({ ...preview, positions: preview.positions.filter((_, j) => j !== i) })
                          }
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card-h">
              现金余额
              {preview.cash.some((c) => !c.fromParse) && (
                <span className="chip warn">未能从月结单自动提取，请手动填写</span>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
              {preview.cash.map((c, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select
                    className="select"
                    style={{ width: 90, padding: "5px 8px", fontSize: 12 }}
                    value={c.currency}
                    onChange={(e) => {
                      const next = [...preview.cash];
                      next[i] = { ...c, currency: e.target.value };
                      setPreview({ ...preview, cash: next });
                    }}
                  >
                    <option>USD</option>
                    <option>HKD</option>
                    <option>CNY</option>
                  </select>
                  <input
                    className="input sm"
                    style={{ width: 150 }}
                    type="number"
                    placeholder="金额"
                    value={c.amount}
                    onChange={(e) => {
                      const next = [...preview.cash];
                      next[i] = { ...c, amount: e.target.value };
                      setPreview({ ...preview, cash: next });
                    }}
                  />
                  <span className={`chip ${c.fromParse ? "ok" : "gray"}`}>{c.fromParse ? "自动提取" : "手动"}</span>
                  <button
                    className="btn danger sm"
                    onClick={() => setPreview({ ...preview, cash: preview.cash.filter((_, j) => j !== i) })}
                  >
                    删除
                  </button>
                </div>
              ))}
              <button
                className="btn ghost sm"
                style={{ alignSelf: "flex-start" }}
                onClick={() =>
                  setPreview({ ...preview, cash: [...preview.cash, { currency: "USD", amount: "", fromParse: false }] })
                }
              >
                + 添加币种
              </button>
            </div>

            <button className="btn" disabled={saving} onClick={save}>
              {saving ? <span className="spin" /> : `确认保存快照（${brokerMeta?.label} @ ${preview.asOf}）`}
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-h">历史快照</div>
        {listBusy ? (
          <div className="empty">
            <span className="spin dark" />
          </div>
        ) : statements.length === 0 ? (
          <div className="empty">还没有保存过快照</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>券商</th>
                <th>快照日期</th>
                <th>文件</th>
                <th className="num">持仓数</th>
                <th className="num">现金记录</th>
                <th>上传时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {statements.map((s) => (
                <tr key={s.id}>
                  <td>
                    <b>{BROKERS.find((b) => b.id === s.broker)?.label ?? s.broker}</b>
                  </td>
                  <td>{s.asOf}</td>
                  <td style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.fileName}
                  </td>
                  <td className="num">{s.positionCount}</td>
                  <td className="num">{s.cashCount}</td>
                  <td style={{ color: "var(--ink-4)", fontSize: 12 }}>{s.uploadedAt}</td>
                  <td>
                    <button className="btn danger sm" onClick={() => remove(s.id)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

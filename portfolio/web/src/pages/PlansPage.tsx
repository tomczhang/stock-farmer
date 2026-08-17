
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { fmtMoney } from "../components/Chart";
import { TradingViewWidget } from "../components/TradingViewWidget";
import {
  PLAN_TEMPLATES,
  buildTemplateTiers,
  canExecuteTier,
  canPlanStartExecution,
  hasPendingExecution,
  sameInstrument,
  type PlanTemplateId,
} from "../lib/portfolio/plans";
import { describeCoverageItems } from "../lib/portfolio/coverage";
import { aggregateSummaryPositions } from "../lib/portfolio/positions";
import type {
  Bucket,
  BucketBudget,
  BucketBudgetResult,
  Currency,
  Plan,
  PlanComparisonResult,
  PlanInput,
  PlanInputTier,
  RiskSettings,
  SafetyAddResult,
  SafetyRoom,
  Summary,
} from "../types";
import { BUCKET_LABELS } from "../types";

interface TierDraft {
  triggerType: "pct_drop" | "price" | "pct_gain";
  triggerValue: string;
  allocType: "pct" | "amount";
  allocValue: string;
}

interface PlanDraft {
  id?: number;
  symbol: string;
  name: string;
  market: string;
  currency: Currency;
  scenarioName: string;
  basePrice: string;
  totalBudget: string;
  estimatedFee: string;
  note: string;
  templateId?: PlanTemplateId;
  direction: "add" | "trim";
  tiers: TierDraft[];
}

/** 预算只面向自主投资仓别；授予仓（RSU）不参与加仓预算。 */
type BudgetBucket = Exclude<Bucket, "grant">;

const BUCKETS: BudgetBucket[] = ["aggressive", "defensive", "stable"];

function currentQuarter() {
  const now = new Date();
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
}

interface BudgetDraft {
  amount: string;
  currency: Currency;
}

function tiersFromTemplate(templateId: PlanTemplateId): TierDraft[] {
  return buildTemplateTiers(PLAN_TEMPLATES[templateId]).map((tier) => ({
    triggerType: tier.triggerType,
    triggerValue: String(tier.triggerValue),
    allocType: tier.allocType,
    allocValue: String(tier.allocValue),
  }));
}

function toPlanInput(draft: PlanDraft): PlanInput {
  return {
    symbol: draft.symbol.trim().toUpperCase(),
    name: draft.name.trim() || draft.symbol.trim().toUpperCase(),
    market: draft.market,
    currency: draft.currency,
    scenarioName: draft.scenarioName.trim() || draft.templateId || "自定义方案",
    basePrice: Number(draft.basePrice),
    totalBudget: draft.direction === "trim" ? Number(draft.totalBudget || 0) : Number(draft.totalBudget),
    estimatedFee: Number(draft.estimatedFee || 0),
    note: draft.note.trim() || undefined,
    templateWeights: draft.direction === "add" && draft.templateId ? [...PLAN_TEMPLATES[draft.templateId]] : undefined,
    direction: draft.direction,
    tiers: draft.tiers.map((tier, index): PlanInputTier => ({
      seq: index + 1,
      triggerType: tier.triggerType,
      triggerValue: Number(tier.triggerValue),
      allocType: tier.allocType,
      allocValue: Number(tier.allocValue),
    })),
  };
}

const ROOM_LABELS: Record<keyof SafetyAddResult["rooms"], string> = {
  symbol: "标的集中度",
  bucket: "单仓集中度",
  cash: "现金安全线",
  budget: "季度仓预算",
};

function roomAmount(room: SafetyRoom | null | undefined, currency: Currency) {
  return room?.amount == null ? "待补录" : `${fmtMoney(Math.max(0, room.amount), 0)} ${currency}`;
}

function SafetyCard({ result, loading, symbol, estimatedFee }: { result: SafetyAddResult | null; loading: boolean; symbol?: string; estimatedFee: number }) {
  if (loading) return <section className="card safety-card"><div className="empty"><span className="spin dark" /></div></section>;
  if (!symbol) return <section className="card safety-card"><div className="card-h">安全加仓金额<span className="tag">先选标的</span></div><div className="empty">选择当前持仓标的后，后端会统一模拟四项约束。</div></section>;
  if (!result) return <section className="card safety-card"><div className="card-h">安全加仓金额</div><div className="empty">暂无安全计算结果</div></section>;

  const currency = result.currency ?? "USD";
  const missing = describeCoverageItems(result.missing ?? result.coverage?.missing ?? []);
  const bottleneck = result.bottleneck && ROOM_LABELS[result.bottleneck] ? result.bottleneck : null;

  return (
    <section className="card safety-card" aria-labelledby="safe-add-title">
      <div className="card-h" id="safe-add-title">
        安全加仓金额
        <span className={`chip ${result.complete ? "ok" : "warn"}`}>{result.complete ? "约束完整" : "待补录"}</span>
      </div>
      <div className="safe-amount">
        <span>{symbol} 当前最多可安全投入</span>
        <b>{result.safeAmount == null ? "无法计算" : `${fmtMoney(result.safeAmount, 0)} ${currency}`}</b>
        <small>{bottleneck ? `当前瓶颈：${ROOM_LABELS[bottleneck]}` : "四项约束均由后端统一模拟"} · 已扣预计交易费 {fmtMoney(Number.isFinite(estimatedFee) ? estimatedFee : 0)} {currency}</small>
      </div>
      {missing.length > 0 && <div className="alert warn compact-alert">待完成：{missing.join("；")}</div>}
      <div className="safe-room-grid">
        {(Object.keys(ROOM_LABELS) as Array<keyof typeof ROOM_LABELS>).map((key) => {
          const room = result.rooms?.[key];
          return (
            <div key={key} className={`safe-room ${bottleneck === key ? "bottleneck" : ""}`}>
              <span>{ROOM_LABELS[key]}{bottleneck === key ? " · 瓶颈" : ""}</span>
              <b>{roomAmount(room, currency)}</b>
              {(room?.currentRatio != null || room?.postRatio != null) && (
                <small>
                  {room?.currentRatio == null ? "—" : `${(room.currentRatio * 100).toFixed(1)}%`}
                  {" → "}
                  {room?.postRatio == null ? "—" : `${(room.postRatio * 100).toFixed(1)}%`}
                </small>
              )}
            </div>
          );
        })}
      </div>
      <details className="formula-details">
        <summary>查看计算说明</summary>
        <p>集中度以加仓后持仓总市值为分母，现金不参与稀释；最终金额取四项额度的最小值。</p>
        <dl>{Object.entries(result.context ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value ?? "—"}</dd></div>)}</dl>
      </details>
    </section>
  );
}

function ScenarioImpact({ plan }: { plan: Plan }) {
  const final = plan.final;
  return (
    <article className="scenario-impact">
      <div className="scenario-impact-title">
        <b>{plan.scenarioName ?? plan.name}</b>
        <span className={`chip ${final?.safe ? "ok" : "warn"}`}>{final?.safe ? "安全" : "有约束"}</span>
      </div>
      <dl>
        <div><dt>总投入</dt><dd>{fmtMoney(plan.totalPlanned, 0)} {plan.currency}</dd></div>
        <div><dt>总预计交易费</dt><dd>{fmtMoney(plan.estimatedFee ?? 0)} {plan.currency}</dd></div>
        <div><dt>新增数量</dt><dd>{final?.quantity != null && plan.currentPosition?.quantity != null ? fmtMoney(final.quantity - plan.currentPosition.quantity, 0) : "—"}</dd></div>
        <div><dt>加仓后账面成本</dt><dd>{final?.bookCost == null ? "—" : `${fmtMoney(final.bookCost, 0)} ${plan.currency}`}</dd></div>
        <div><dt>加仓后均价</dt><dd>{final?.avgCost == null ? "—" : `${fmtMoney(final.avgCost)} ${plan.currency}`}</dd></div>
        <div><dt>剩余现金 / 现金率</dt><dd>{final?.cash == null ? "—" : `${fmtMoney(final.cash, 0)} ${plan.currency}`} · {final?.cashRatio == null ? "—" : `${(final.cashRatio * 100).toFixed(1)}%`}</dd></div>
        <div><dt>标的 / 仓集中度</dt><dd>{final?.symbolRatio == null ? "—" : `${(final.symbolRatio * 100).toFixed(1)}%`} · {final?.bucketRatio == null ? "—" : `${(final.bucketRatio * 100).toFixed(1)}%`}</dd></div>
        <div><dt>仓预算余量</dt><dd>{final?.budgetAvailable == null ? "—" : `${fmtMoney(final.budgetAvailable, 0)} ${plan.currency}`}</dd></div>
      </dl>
    </article>
  );
}

export default function PlansPage() {
  const [quarter] = useState(currentQuarter);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [riskSettings, setRiskSettings] = useState<RiskSettings | null>(null);
  const [riskDraft, setRiskDraft] = useState({ symbolLimit: "50", bucketLimit: "50", cashFloor: "30" });
  const [budgets, setBudgets] = useState<BucketBudget[]>([]);
  const [budgetDrafts, setBudgetDrafts] = useState<Record<BudgetBucket, BudgetDraft>>({
    aggressive: { amount: "", currency: "USD" },
    defensive: { amount: "", currency: "USD" },
    stable: { amount: "", currency: "USD" },
  });
  const [decisionKey, setDecisionKey] = useState("");
  const [estimatedFee, setEstimatedFee] = useState("0");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const [comparison, setComparison] = useState<PlanComparisonResult | null>(null);
  const [safety, setSafety] = useState<SafetyAddResult | null>(null);
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [busy, setBusy] = useState(true);
  const [safetyBusy, setSafetyBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rulesSaving, setRulesSaving] = useState<string | null>(null);
  const [rulesRevision, setRulesRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [nextPlans, nextSummary, nextSettings, nextBudgetResult] = await Promise.all([
        api.get<Plan[]>("/api/plans"),
        api.get<Summary>("/api/portfolio/summary?display=USD"),
        api.get<RiskSettings>("/api/risk-settings"),
        api.get<BucketBudgetResult>(`/api/bucket-budgets?quarter=${quarter}`),
      ]);
      setPlans(nextPlans);
      setSummary(nextSummary);
      setRiskSettings(nextSettings);
      setRiskDraft({
        symbolLimit: String(nextSettings.symbolLimit * 100),
        bucketLimit: String(nextSettings.bucketLimit * 100),
        cashFloor: String(nextSettings.cashFloor * 100),
      });
      setBudgets(nextBudgetResult.budgets);
      setBudgetDrafts((current) => {
        const next = { ...current };
        for (const bucket of BUCKETS) {
          const item = nextBudgetResult.budgets.find((budget) => budget.bucket === bucket);
          next[bucket] = {
            amount: item?.limitAmount == null ? "" : String(item.limitAmount),
            currency: item?.currency ?? current[bucket].currency,
          };
        }
        return next;
      });
      const nextInstruments = aggregateSummaryPositions(nextSummary.positions, nextSummary.kpi.positionsValue, nextSummary.instruments);
      const nextCalculable = nextInstruments.filter((position) => BUCKETS.includes(position.bucket as BudgetBucket));
      setDecisionKey((current) => nextCalculable.some((position) => position.key === current)
        ? current
        : nextCalculable[0]?.key ?? "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加仓计划加载失败");
    } finally {
      setBusy(false);
    }
  }, [quarter]);

  useEffect(() => { void load(); }, [load]);

  const instrumentPositions = useMemo(
    () => aggregateSummaryPositions(summary?.positions ?? [], summary?.kpi.positionsValue ?? 0, summary?.instruments),
    [summary],
  );
  const calculablePositions = useMemo(
    () => instrumentPositions.filter((position) => BUCKETS.includes(position.bucket as BudgetBucket)),
    [instrumentPositions],
  );
  const decisionPosition = useMemo(
    () => calculablePositions.find((position) => position.key === decisionKey) ?? null,
    [calculablePositions, decisionKey],
  );

  useEffect(() => {
    if (!decisionPosition) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) => {
      const currentPlan = plans.find((plan) => plan.id === current);
      if (currentPlan?.market === decisionPosition.market && currentPlan.symbol === decisionPosition.symbol) return current;
      return plans.find((plan) => plan.market === decisionPosition.market && plan.symbol === decisionPosition.symbol)?.id ?? null;
    });
  }, [decisionPosition, plans]);

  useEffect(() => {
    if (!decisionPosition) {
      setSafety(null);
      return;
    }
    let active = true;
    setSafetyBusy(true);
    api.post<SafetyAddResult>("/api/portfolio/safe-add", {
      market: decisionPosition.market,
      symbol: decisionPosition.symbol,
      bucket: decisionPosition.bucket === "unassigned" ? undefined : decisionPosition.bucket,
      currency: decisionPosition.currency,
      estimatedFee: Math.max(0, Number(estimatedFee) || 0),
      display: "USD",
    }).then((result) => {
      if (active) setSafety(result);
    }).catch((err) => {
      if (active) setError(err instanceof ApiError ? err.message : "安全金额加载失败");
    }).finally(() => {
      if (active) setSafetyBusy(false);
    });
    return () => { active = false; };
  }, [decisionPosition, estimatedFee, rulesRevision]);

  useEffect(() => {
    if (compareIds.length < 2) {
      setComparison(null);
      return;
    }
    let active = true;
    api.post<PlanComparisonResult>("/api/plans/compare", { planIds: compareIds }).then((result) => {
      if (active) setComparison(result);
    }).catch((err) => {
      if (active) {
        setComparison(null);
        setError(err instanceof ApiError ? err.message : "方案比较失败");
      }
    });
    return () => { active = false; };
  }, [compareIds]);

  const plansForDecision = decisionPosition
    ? plans.filter((plan) => plan.market === decisionPosition.market && plan.symbol === decisionPosition.symbol)
    : [];
  const selected = plansForDecision.find((plan) => plan.id === selectedId) ?? null;
  const pendingExecutionPlans = plans.filter(hasPendingExecution);

  const openDraft = (plan?: Plan, templateId: PlanTemplateId = "1234", direction: "add" | "trim" = "add") => {
    if (plan) {
      setDraft({
        id: plan.id,
        symbol: plan.symbol,
        name: plan.name,
        market: plan.market,
        currency: plan.currency,
        scenarioName: plan.scenarioName ?? plan.name,
        basePrice: String(plan.basePrice),
        totalBudget: String(plan.totalBudget),
        estimatedFee: String(plan.estimatedFee ?? 0),
        note: plan.note ?? "",
        direction: plan.direction ?? "add",
        tiers: plan.tiers.map((tier) => ({
          triggerType: tier.triggerType,
          triggerValue: String(tier.triggerValue),
          allocType: tier.allocType,
          allocValue: String(tier.allocValue),
        })),
      });
      return;
    }
    if (direction === "trim") {
      setDraft({
        symbol: decisionPosition?.symbol ?? "",
        name: decisionPosition?.name ?? "",
        market: decisionPosition?.market ?? "US",
        currency: decisionPosition?.currency ?? "USD",
        scenarioName: "",
        basePrice: decisionPosition?.currentPrice == null ? "" : String(decisionPosition.currentPrice),
        totalBudget: "0",
        estimatedFee: String(Math.max(0, Number(estimatedFee) || 0)),
        note: "",
        direction: "trim",
        tiers: [
          { triggerType: "pct_gain", triggerValue: "20", allocType: "pct", allocValue: "30" },
          { triggerType: "pct_gain", triggerValue: "40", allocType: "pct", allocValue: "30" },
        ],
      });
      return;
    }
    setDraft({
      symbol: decisionPosition?.symbol ?? "",
      name: decisionPosition?.name ?? "",
      market: decisionPosition?.market ?? "US",
      currency: decisionPosition?.currency ?? "USD",
      scenarioName: templateId,
      basePrice: decisionPosition?.currentPrice == null ? "" : String(decisionPosition.currentPrice),
      totalBudget: safety?.safeAmount == null ? "" : String(Math.floor(safety.safeAmount)),
      estimatedFee: String(Math.max(0, Number(estimatedFee) || 0)),
      note: "",
      templateId,
      direction: "add",
      tiers: tiersFromTemplate(templateId),
    });
  };

  const applyTemplate = (templateId: PlanTemplateId) => {
    if (draft) setDraft({ ...draft, templateId, scenarioName: templateId, tiers: tiersFromTemplate(templateId) });
  };

  const savePlan = async () => {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const input = toPlanInput(draft);
      const saved = draft.id
        ? await api.put<Plan>(`/api/plans/${draft.id}`, input)
        : await api.post<Plan>("/api/plans", input);
      setDraft(null);
      setNotice(`${saved.symbol} · ${saved.scenarioName ?? saved.name} 已保存`);
      await load();
      setSelectedId(saved.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "方案保存失败");
    } finally {
      setSaving(false);
    }
  };

  const removePlan = async (id: number) => {
    if (!window.confirm("确定删除该加仓方案？")) return;
    try {
      await api.delete(`/api/plans/${id}`);
      setCompareIds((current) => current.filter((value) => value !== id));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  const toggleCompare = (plan: Plan) => {
    setCompareIds((current) => {
      if (current.includes(plan.id)) return current.filter((id) => id !== plan.id);
      const existing = plans.filter((item) => current.includes(item.id));
      if (existing.length > 0 && !sameInstrument([...existing, plan])) {
        setError("只能比较同一市场、同一标的的方案");
        return current;
      }
      return [...current, plan.id];
    });
  };

  const toggleFill = async (plan: Plan, tierId: number, filled: boolean) => {
    try {
      await api.put(`/api/plans/${plan.id}/tiers/${tierId}/fill`, { filled });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "当前档位无法标记成交");
    }
  };

  const saveRiskSettings = async () => {
    const input = {
      symbolLimit: Number(riskDraft.symbolLimit) / 100,
      bucketLimit: Number(riskDraft.bucketLimit) / 100,
      cashFloor: Number(riskDraft.cashFloor) / 100,
    };
    if (!(input.symbolLimit > 0 && input.symbolLimit < 1)
      || !(input.bucketLimit > 0 && input.bucketLimit < 1)
      || !(input.cashFloor >= 0 && input.cashFloor < 1)) {
      setError("集中度需大于 0% 且低于 100%，现金安全线需在 0%（含）到 100% 之间");
      return;
    }
    setRulesSaving("risk");
    setError("");
    try {
      const saved = await api.put<RiskSettings>("/api/risk-settings", input);
      setRiskSettings(saved);
      setNotice("安全边界已更新");
      setRulesRevision((value) => value + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "安全边界保存失败");
    } finally {
      setRulesSaving(null);
    }
  };

  const saveBucketBudget = async (bucket: BudgetBucket) => {
    const draftValue = budgetDrafts[bucket];
    const amount = Number(draftValue.amount);
    if (!(amount > 0)) {
      setError("季度仓预算必须大于 0");
      return;
    }
    setRulesSaving(bucket);
    setError("");
    try {
      const saved = await api.put<BucketBudget>("/api/bucket-budgets", {
        bucket,
        quarter,
        limitAmount: amount,
        currency: draftValue.currency,
      });
      setBudgets((current) => current.some((item) => item.bucket === bucket)
        ? current.map((item) => item.bucket === bucket ? saved : item)
        : [...current, saved]);
      setBudgetDrafts((current) => ({
        ...current,
        [bucket]: { amount: saved.limitAmount == null ? "" : String(saved.limitAmount), currency: saved.currency ?? draftValue.currency },
      }));
      setNotice(`${BUCKET_LABELS[bucket]} ${quarter} 预算已更新`);
      setRulesRevision((value) => value + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "季度仓预算保存失败");
    } finally {
      setRulesSaving(null);
    }
  };

  const draftReady = !!draft
    && !!draft.symbol.trim()
    && Number(draft.basePrice) > 0
    && (draft.direction === "trim" || Number(draft.totalBudget) > 0)
    && Number(draft.estimatedFee) >= 0
    && draft.tiers.every((tier) => Number(tier.triggerValue) > 0 && Number(tier.allocValue) > 0);

  return (
    <div className="fade-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">加仓计划</h1>
          <p className="page-desc">先看安全金额，再比较同一标的的多个加仓方案；行情仅作次级参考。</p>
        </div>
        <div className="heading-actions">
          <button className="btn" disabled={!decisionPosition} onClick={() => openDraft()}>新建加仓方案</button>
          <button className="btn ghost" disabled={!decisionPosition} onClick={() => openDraft(undefined, "1234", "trim")}>新建减仓方案</button>
        </div>
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert ok" role="status">{notice}</div>}

      <div className="decision-symbol-row">
        <div className="field">
          <label htmlFor="decision-symbol">决策标的</label>
          <select id="decision-symbol" className="select" value={decisionKey} onChange={(event) => { setDecisionKey(event.target.value); setCompareIds([]); }}>
            {calculablePositions.length
              ? calculablePositions.map((position) => <option key={position.key} value={position.key}>{position.symbol} · {position.name} · {BUCKET_LABELS[position.bucket] ?? position.bucket}</option>)
              : <option value="">暂无可计算标的</option>}
          </select>
        </div>
        <div className="field decision-fee-field">
          <label htmlFor="decision-estimated-fee">本次预计交易费（{decisionPosition?.currency ?? "原币"}）</label>
          <input id="decision-estimated-fee" className="input" type="number" min="0" step="0.01" value={estimatedFee} disabled={!decisionPosition} onChange={(event) => setEstimatedFee(event.target.value)} />
        </div>
        {decisionPosition && (
          <div className="position-context">
            <div><span>当前数量</span><b>{fmtMoney(decisionPosition.quantity, 0)}</b></div>
            <div><span>账面成本</span><b>{decisionPosition.bookCost == null ? "待补录" : `${fmtMoney(decisionPosition.bookCost, 0)} ${decisionPosition.currency}`}</b></div>
            <div><span>持仓内占比</span><b>{decisionPosition.holdingRatio == null ? "—" : `${(decisionPosition.holdingRatio * 100).toFixed(1)}%`}</b></div>
          </div>
        )}
      </div>

      {instrumentPositions.length === 0 && <div className="alert warn">需要先有持仓数据才能计算安全金额。<Link to="/data">前往数据管理</Link></div>}
      {instrumentPositions.length > 0 && calculablePositions.length === 0 && <div className="alert warn">现有持仓尚未分配仓别，因此暂无可计算标的。<Link to="/holdings">前往持仓分析分配仓别</Link></div>}
      <details className="card capital-rules" open={!riskSettings || (decisionPosition ? budgets.find((budget) => budget.bucket === decisionPosition.bucket)?.limitAmount == null : budgets.every((budget) => budget.limitAmount == null))}>
        <summary>
          <span>资金规则</span>
          <small>{quarter} · 集中度与现金线可随时调整，单仓预算每季度可再调整一次</small>
        </summary>
        <div className="capital-rules-body">
          <section aria-labelledby="risk-settings-title">
            <div className="subsection-heading" id="risk-settings-title">
              <b>安全边界</b>
              <span className="tag">{riskSettings?.source === "custom" ? "自定义" : "默认规则"}</span>
            </div>
            <div className="risk-settings-grid">
              {([
                ["symbolLimit", "单一标的上限"],
                ["bucketLimit", "单一仓上限"],
                ["cashFloor", "最低现金率"],
              ] as const).map(([key, label]) => (
                <div className="field" key={key}>
                  <label htmlFor={`risk-${key}`}>{label}</label>
                  <div className="input-suffix">
                    <input id={`risk-${key}`} className="input" type="number" min="0" max="99.99" step="0.01" value={riskDraft[key]} onChange={(event) => setRiskDraft({ ...riskDraft, [key]: event.target.value })} />
                    <span>%</span>
                  </div>
                </div>
              ))}
              <button className="btn rules-save" disabled={rulesSaving != null} onClick={saveRiskSettings}>{rulesSaving === "risk" ? <span className="spin" /> : "保存边界"}</button>
            </div>
            <p className="rules-note">集中度分母为加仓后的持仓总市值，现金单独受最低现金率约束。</p>
          </section>
          <section aria-labelledby="bucket-budget-title">
            <div className="subsection-heading" id="bucket-budget-title"><b>{quarter} 单仓资金预算</b><span className="tag">金额按录入币种保存</span></div>
            <div className="budget-rule-grid">
              {BUCKETS.map((bucket) => {
                const item = budgets.find((budget) => budget.bucket === bucket);
                const draftValue = budgetDrafts[bucket];
                const canAdjust = item?.canAdjust ?? true;
                return (
                  <article className={`budget-rule ${decisionPosition?.bucket === bucket ? "active" : ""}`} key={bucket}>
                    <div className="budget-rule-title">
                      <b>{BUCKET_LABELS[bucket]}</b>
                      <span className={`chip ${item?.coverage.status === "complete" ? "ok" : "warn"}`}>{item?.limitAmount == null ? "未设置" : canAdjust ? "可调整 1 次" : "本季已锁定"}</span>
                    </div>
                    <div className="budget-input-row">
                      <input aria-label={`${BUCKET_LABELS[bucket]}预算金额`} className="input" type="number" min="0" value={draftValue.amount} disabled={!canAdjust} onChange={(event) => setBudgetDrafts({ ...budgetDrafts, [bucket]: { ...draftValue, amount: event.target.value } })} />
                      <select aria-label={`${BUCKET_LABELS[bucket]}预算币种`} className="select" value={draftValue.currency} disabled={!canAdjust} onChange={(event) => setBudgetDrafts({ ...budgetDrafts, [bucket]: { ...draftValue, currency: event.target.value as Currency } })}><option>USD</option><option>HKD</option><option>CNY</option></select>
                      <button className="btn ghost sm" disabled={!canAdjust || rulesSaving != null} onClick={() => saveBucketBudget(bucket)}>{rulesSaving === bucket ? <span className="spin dark" /> : item?.limitAmount == null ? "设置" : "调整"}</button>
                    </div>
                    <dl className="budget-rule-metrics">
                      <div><dt>已用</dt><dd>{item ? `${fmtMoney(item.usedUsd, 0)} USD` : "—"}</dd></div>
                      <div><dt>可用</dt><dd>{item?.availableUsd == null ? "待设置" : `${fmtMoney(item.availableUsd, 0)} USD`}</dd></div>
                      <div><dt>本季调整</dt><dd>{item?.adjustmentsUsed ?? 0} / 1</dd></div>
                    </dl>
                    {!canAdjust && item?.nextAdjustableQuarter && <small className="rules-note">下次可调：{item.nextAdjustableQuarter}</small>}
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      </details>
      <SafetyCard result={safety} loading={safetyBusy} symbol={decisionPosition?.symbol} estimatedFee={Math.max(0, Number(estimatedFee) || 0)} />

      {pendingExecutionPlans.length > 0 && (
        <div className="alert warn" role="status">
          {pendingExecutionPlans.map((plan) => `${plan.symbol} · ${plan.scenarioName ?? plan.name}`).join("、")} 存在已成交但尚未同步到最新持仓的数据。整个资产账户同一时间仅允许一个方案保留未同步成交档位；同步持仓后请取消旧标记，再执行其他方案。
        </div>
      )}

      <section className="card section-card" aria-labelledby="scenario-title">
        <div className="card-h" id="scenario-title">同股方案<span className="tag">选择至少 2 个并排比较</span></div>
        {busy && plans.length === 0 ? <div className="empty"><span className="spin dark" /></div> : plansForDecision.length === 0 ? (
          <div className="empty scenario-empty">
            <p>还没有 {decisionPosition?.symbol ?? "该标的"} 的方案。</p>
            <div className="template-actions">
              <button className="btn" onClick={() => openDraft(undefined, "1248")}>创建 1:2:4:8</button>
              <button className="btn ghost" onClick={() => openDraft(undefined, "1234")}>创建 1:2:3:4</button>
            </div>
          </div>
        ) : (
          <div className="scenario-selector" role="group" aria-label="选择比较方案">
            {plansForDecision.map((plan) => (
              <article key={plan.id} className={`scenario-card ${selectedId === plan.id ? "active" : ""}`}>
                <button className="scenario-main" onClick={() => setSelectedId(plan.id)}>
                  <b>{plan.scenarioName ?? plan.name}<span className={`chip ${plan.direction === "trim" ? "warn" : "ok"}`} style={{ marginLeft: 6 }}>{plan.direction === "trim" ? "减仓" : "加仓"}</span></b>
                  <span>{plan.direction === "trim"
                    ? `${plan.symbol} · 计划卖出 ${fmtMoney(plan.totalSellQuantity ?? 0, 0)} 股 · 回收 ~${fmtMoney(plan.totalNetProceeds ?? 0, 0)} ${plan.currency}`
                    : `${plan.symbol} · 预算 ${fmtMoney(plan.totalBudget, 0)} ${plan.currency}`}</span>
                </button>
                {plan.direction !== "trim" && <label className="check-field"><input type="checkbox" checked={compareIds.includes(plan.id)} onChange={() => toggleCompare(plan)} />加入比较</label>}
                <div className="scenario-actions"><button className="btn ghost sm" onClick={() => openDraft(plan)}>编辑</button><button className="btn danger sm" onClick={() => removePlan(plan.id)}>删除</button></div>
              </article>
            ))}
          </div>
        )}
      </section>

      {comparison && (
        <section className="card section-card" aria-labelledby="compare-title">
          <div className="card-h" id="compare-title">方案影响比较<span className="tag">{comparison.symbol}</span></div>
          <div className="scenario-compare-grid">{comparison.scenarios.map((plan) => <ScenarioImpact key={plan.id ?? plan.scenarioName} plan={plan} />)}</div>
          <div className="table-scroll compare-tier-table" tabIndex={0} aria-label="逐档方案比较，可横向滚动">
            <table className="table">
              <thead><tr><th>方案</th><th>档位</th><th className="num">买入价</th><th className="num">本档投入</th><th className="num">加仓后数量</th><th className="num">加仓后账面成本</th><th className="num">加仓后均价</th><th>安全</th></tr></thead>
              <tbody>{comparison.scenarios.flatMap((plan) => plan.tiers.map((tier) => <tr key={`${plan.id}-${tier.id}`}><td>{plan.scenarioName ?? plan.name}</td><td>第 {tier.seq} 档</td><td className="num">{fmtMoney(tier.buyPrice)} {plan.currency}</td><td className="num">{fmtMoney(tier.amount, 0)} {plan.currency}</td><td className="num">{tier.postQuantity == null ? "—" : fmtMoney(tier.postQuantity, 0)}</td><td className="num">{tier.postBookCost == null ? "—" : `${fmtMoney(tier.postBookCost, 0)} ${plan.currency}`}</td><td className="num">{tier.postAvgCost == null ? "—" : `${fmtMoney(tier.postAvgCost)} ${plan.currency}`}</td><td><span className={`chip ${tier.safety?.candidate?.safe ? "ok" : "warn"}`}>{tier.safety?.candidate?.safe ? "安全" : "超限/不完整"}</span></td></tr>))}</tbody>
            </table>
          </div>
        </section>
      )}

      {selected && !draft && (selected.direction === "trim" ? (
        <section className="card section-card" aria-labelledby="selected-plan-title">
          <div className="card-h" id="selected-plan-title">{selected.symbol} · {selected.scenarioName ?? selected.name}<span className="chip warn">减仓方案</span></div>
          <div className="pnl-breakdown">
            <div><span>当前持仓</span><b>{fmtMoney(selected.currentPosition?.quantity ?? 0, 0)} 股</b></div>
            <div><span>计划卖出</span><b>{fmtMoney(selected.totalSellQuantity ?? 0, 0)} 股</b></div>
            <div><span>预计回收（含费前/后）</span><b>{fmtMoney(selected.totalProceeds ?? 0, 0)} / {fmtMoney(selected.totalNetProceeds ?? 0, 0)} {selected.currency}</b></div>
            <div><span>卖完后剩余</span><b>{selected.final?.quantity == null ? "—" : `${fmtMoney(selected.final.quantity, 0)} 股`}</b></div>
          </div>
          <div className="table-scroll" tabIndex={0} aria-label="减仓档位，可横向滚动">
            <table className="table plan-tier-table">
              <thead><tr><th>档位</th><th>触发</th><th className="num">卖出价</th><th className="num">卖出数量</th><th className="num">回收现金</th><th className="num">卖后剩余</th><th className="num">卖后账面成本</th><th className="num">标的占比</th><th className="num">现金率</th><th>成交</th></tr></thead>
              <tbody>{selected.tiers.map((tier) => {
                const executionSlotAvailable = canPlanStartExecution(selected.id, plans);
                return <tr key={tier.id} className={tier.filledAt ? "filled-row" : ""}><td>第 {tier.seq} 档</td><td>{tier.triggerType === "pct_gain" ? `涨 ${tier.triggerValue}%` : `价格 ${fmtMoney(tier.triggerValue)} ${selected.currency}`}</td><td className="num">{tier.sellPrice == null ? "—" : `${fmtMoney(tier.sellPrice)} ${selected.currency}`}</td><td className="num">{tier.quantity == null ? "—" : fmtMoney(tier.quantity, 0)}</td><td className="num">{tier.proceeds == null ? "—" : `${fmtMoney(tier.proceeds, 0)} ${selected.currency}`}</td><td className="num">{tier.postQuantity == null ? "—" : fmtMoney(tier.postQuantity, 0)}</td><td className="num">{tier.postBookCost == null ? "—" : `${fmtMoney(tier.postBookCost, 0)} ${selected.currency}`}</td><td className="num">{tier.postSymbolRatio == null ? "—" : `${(tier.postSymbolRatio * 100).toFixed(1)}%`}</td><td className="num">{tier.postCashRatio == null ? "—" : `${(tier.postCashRatio * 100).toFixed(1)}%`}</td><td><label className="check-field"><input type="checkbox" checked={!!tier.filledAt} disabled={!tier.filledAt && !executionSlotAvailable} title={!tier.filledAt && !executionSlotAvailable ? "资产账户内已有其他方案存在未同步成交档位" : undefined} onChange={(event) => toggleFill(selected, tier.id, event.target.checked)} />{tier.filledAt ? "已成交" : "标记成交"}</label></td></tr>;
              })}</tbody>
            </table>
          </div>
          <p className="helper-text">卖出模拟不计税负；账面成本按卖出数量等比结转，每股摊薄成本不变。</p>
          <details className="market-reference"><summary>行情参考（次级）</summary><TradingViewWidget symbol={selected.symbol} market={selected.market} height={460} /></details>
        </section>
      ) : (
        <section className="card section-card" aria-labelledby="selected-plan-title">
          <div className="card-h" id="selected-plan-title">{selected.symbol} · {selected.scenarioName ?? selected.name}<span className={`chip ${selected.final?.safe ? "ok" : "warn"}`}>{selected.final?.safe ? "安全方案" : "草稿/有约束"}</span></div>
          <ScenarioImpact plan={selected} />
          <div className="table-scroll" tabIndex={0} aria-label="方案档位，可横向滚动">
            <table className="table plan-tier-table">
              <thead><tr><th>档位</th><th>触发</th><th className="num">买入价</th><th className="num">投入</th><th className="num">加仓后数量</th><th className="num">加仓后均价</th><th>成交</th></tr></thead>
              <tbody>{selected.tiers.map((tier) => {
                const executionSlotAvailable = canPlanStartExecution(selected.id, plans);
                const canFill = canExecuteTier(tier, selected.coverage) && executionSlotAvailable;
                const blockedTitle = !executionSlotAvailable
                  ? "资产账户内已有其他方案存在未同步成交档位"
                  : "安全校验不完整或未通过，不能标记成交";
                return <tr key={tier.id} className={tier.filledAt ? "filled-row" : ""}><td>第 {tier.seq} 档</td><td>{tier.triggerType === "pct_drop" ? `跌 ${tier.triggerValue}%` : `价格 ${fmtMoney(tier.triggerValue)} ${selected.currency}`}</td><td className="num">{fmtMoney(tier.buyPrice)} {selected.currency}</td><td className="num">{fmtMoney(tier.amount, 0)} {selected.currency}</td><td className="num">{tier.postQuantity == null ? "—" : fmtMoney(tier.postQuantity, 0)}</td><td className="num">{tier.postAvgCost == null ? "—" : `${fmtMoney(tier.postAvgCost)} ${selected.currency}`}</td><td><label className="check-field"><input type="checkbox" checked={!!tier.filledAt} disabled={!tier.filledAt && !canFill} title={!tier.filledAt && !canFill ? blockedTitle : undefined} onChange={(event) => toggleFill(selected, tier.id, event.target.checked)} />{tier.filledAt ? "已成交" : canFill ? "标记成交" : "不可执行"}</label></td></tr>;
              })}</tbody>
            </table>
          </div>
          <details className="market-reference"><summary>行情参考（次级）</summary><TradingViewWidget symbol={selected.symbol} market={selected.market} height={460} /></details>
        </section>
      ))}

      {draft && (
        <section className="card section-card plan-editor" aria-labelledby="plan-editor-title">
          <div className="card-h" id="plan-editor-title">{draft.id ? `编辑方案 · ${draft.symbol}` : draft.direction === "trim" ? "新建减仓方案" : "新建加仓方案"}<span className={`chip ${draft.direction === "trim" ? "warn" : "ok"}`}>{draft.direction === "trim" ? "减仓（卖出）" : "加仓（买入）"}</span></div>
          {draft.direction === "add" && (
            <div className="template-picker" role="group" aria-label="方案模板">
              <button className={`btn ${draft.templateId === "1248" ? "" : "ghost"}`} aria-pressed={draft.templateId === "1248"} onClick={() => applyTemplate("1248")}>1:2:4:8 加倍递增</button>
              <button className={`btn ${draft.templateId === "1234" ? "" : "ghost"}`} aria-pressed={draft.templateId === "1234"} onClick={() => applyTemplate("1234")}>1:2:3:4 线性递增</button>
            </div>
          )}
          <div className="plan-form-grid">
            <div className="field"><label htmlFor="plan-symbol">标的代码</label><input id="plan-symbol" className="input" value={draft.symbol} disabled={draft.id != null} onChange={(event) => setDraft({ ...draft, symbol: event.target.value.toUpperCase() })} />{draft.id != null && <small className="field-help">已有方案不可切换标的，请新建方案。</small>}</div>
            <div className="field"><label htmlFor="plan-name">标的名称</label><input id="plan-name" className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
            <div className="field"><label htmlFor="plan-scenario-name">方案名称</label><input id="plan-scenario-name" className="input" value={draft.scenarioName} onChange={(event) => setDraft({ ...draft, scenarioName: event.target.value, templateId: undefined })} /></div>
            <div className="field"><label htmlFor="plan-market">市场</label><select id="plan-market" className="select" value={draft.market} disabled={draft.id != null} onChange={(event) => { const market = event.target.value; setDraft({ ...draft, market, currency: market === "HK" ? "HKD" : "USD" }); }}><option value="US">美股</option><option value="HK">港股</option></select></div>
            <div className="field"><label htmlFor="plan-currency">币种</label><select id="plan-currency" className="select" value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value as Currency })}><option>USD</option><option>HKD</option><option>CNY</option></select></div>
            <div className="field"><label htmlFor="plan-base-price">基准价</label><input id="plan-base-price" className="input" type="number" min="0" value={draft.basePrice} onChange={(event) => setDraft({ ...draft, basePrice: event.target.value })} /></div>
            {draft.direction === "add" && <div className="field"><label htmlFor="plan-budget">总预算（{draft.currency}）</label><input id="plan-budget" className="input" type="number" min="0" value={draft.totalBudget} onChange={(event) => setDraft({ ...draft, totalBudget: event.target.value })} /></div>}
            <div className="field"><label htmlFor="plan-estimated-fee">总预计交易费（{draft.currency}）</label><input id="plan-estimated-fee" className="input" type="number" min="0" step="0.01" value={draft.estimatedFee} onChange={(event) => setDraft({ ...draft, estimatedFee: event.target.value })} /></div>
            <div className="field field-wide"><label htmlFor="plan-note">备注</label><input id="plan-note" className="input" value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></div>
          </div>
          <div className="card-h">档位设置<span className="tag">{draft.direction === "trim" ? "合计卖出不超当前持仓" : "仅正数加仓"}</span></div>
          <div className="tier-editor">
            {draft.tiers.map((tier, index) => (
              <article className="tier-card" key={index}>
                <div className="tier-card-title"><b>第 {index + 1} 档</b><button className="btn danger sm" disabled={draft.tiers.length <= 1} onClick={() => setDraft({ ...draft, tiers: draft.tiers.filter((_, itemIndex) => itemIndex !== index), templateId: undefined })}>删除</button></div>
                <div className="tier-card-fields">
                  <div className="field"><label htmlFor={`tier-trigger-type-${index}`}>触发方式</label><select id={`tier-trigger-type-${index}`} className="select" value={tier.triggerType} onChange={(event) => { const tiers = [...draft.tiers]; tiers[index] = { ...tier, triggerType: event.target.value as TierDraft["triggerType"] }; setDraft({ ...draft, tiers, templateId: undefined }); }}>{draft.direction === "trim" ? <><option value="pct_gain">较基准价涨幅 %</option><option value="price">目标价格</option></> : <><option value="pct_drop">较基准价跌幅 %</option><option value="price">具体价格</option></>}</select></div>
                  <div className="field"><label htmlFor={`tier-trigger-value-${index}`}>触发值</label><input id={`tier-trigger-value-${index}`} className="input" type="number" min="0" value={tier.triggerValue} onChange={(event) => { const tiers = [...draft.tiers]; tiers[index] = { ...tier, triggerValue: event.target.value }; setDraft({ ...draft, tiers, templateId: undefined }); }} /></div>
                  <div className="field"><label htmlFor={`tier-alloc-type-${index}`}>仓位方式</label><select id={`tier-alloc-type-${index}`} className="select" value={tier.allocType} onChange={(event) => { const tiers = [...draft.tiers]; tiers[index] = { ...tier, allocType: event.target.value as TierDraft["allocType"] }; setDraft({ ...draft, tiers, templateId: undefined }); }}>{draft.direction === "trim" ? <><option value="pct">卖出持仓 %</option><option value="amount">固定金额</option></> : <><option value="pct">占预算 %</option><option value="amount">固定金额</option></>}</select></div>
                  <div className="field"><label htmlFor={`tier-alloc-value-${index}`}>仓位值</label><input id={`tier-alloc-value-${index}`} className="input" type="number" min="0" value={tier.allocValue} onChange={(event) => { const tiers = [...draft.tiers]; tiers[index] = { ...tier, allocValue: event.target.value }; setDraft({ ...draft, tiers, templateId: undefined }); }} /></div>
                </div>
              </article>
            ))}
          </div>
          <button className="btn ghost sm" onClick={() => setDraft({ ...draft, templateId: undefined, tiers: [...draft.tiers, { triggerType: draft.direction === "trim" ? "pct_gain" : "pct_drop", triggerValue: "", allocType: "pct", allocValue: "" }] })}>添加档位</button>
          <div className="form-actions"><button className="btn" disabled={saving || !draftReady} onClick={savePlan}>{saving ? <span className="spin" /> : "保存方案"}</button><button className="btn ghost" onClick={() => setDraft(null)}>取消</button></div>
        </section>
      )}
    </div>
  );
}

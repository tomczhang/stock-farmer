/**
 * 4 张指标卡片：当前 PE / 历史中位 / 当前分位 / 历史极值。
 *
 * - 亏损中：当前 PE 卡片显示 "亏损中"、副文案 "无法计算"。
 * - 当前分位：<25% 绿 / 25-75% 灰 / >75% 红。
 * - 历史极值：min - max 同卡展示。
 * - 副信息：亏损时间占比 X%。
 * - 实时 PE 对照：当前 PE 卡片下方追加 "实时 XX.XX ↑/↓ X.XX%"，
 *   仅当 live.is_extended_hours === true 且 pe_ttm_ext 非空时展示，
 *   解决用户跨平台对比（收盘 vs 盘前/盘后）时的口径疑惑。
 */

import type { LiveQuote, MetricsCard } from "../types";

export interface MetricsCardsProps {
  metrics: MetricsCard;
  /** 来自最新 series 点的 is_loss，用于判定 "当前亏损中" */
  currentIsLoss: boolean;
  /** series 最新一点的日期（YYYY-MM-DD），用于 "基于 X/XX 收盘" 副标 */
  latestSeriesDate: string | null;
  /** 实时行情快照；雪球失败或不在盘前盘后时为 null（不展示实时副信息） */
  live: LiveQuote | null;
}

function formatPE(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 100) return value.toFixed(1);
  return value.toFixed(2);
}

function formatPercentile(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function percentileClass(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  if (value < 0.25) return "text-cheap";
  if (value > 0.75) return "text-expensive";
  return "text-neutral";
}

function percentileLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  if (value < 0.25) return "便宜";
  if (value > 0.75) return "贵";
  return "中性";
}

/** "2026-05-21" → "5/21 收盘"；解析失败时回退到原串。 */
function formatCloseDate(isoDate: string | null): string | null {
  if (!isoDate) return null;
  // 直接按 "YYYY-MM-DD" 拆分，避免时区导致的偏差
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return `基于 ${isoDate} 收盘`;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(month) || !Number.isFinite(day)) {
    return `基于 ${isoDate} 收盘`;
  }
  return `基于 ${month}/${day} 收盘`;
}

/** 根据 snapshot UTC 时间粗略判断美股盘前/盘后；都不在则用"延长时段"。
 *  美股 EDT 9:30-16:00 = UTC 13:30-20:00 (冬令时 14:30-21:00)。
 *  用 UTC 而不是用户本地时间，避免浏览器时区影响。 */
function extendedSessionLabel(snapshotAt: string): string {
  const ts = Date.parse(snapshotAt);
  if (Number.isNaN(ts)) return "延长时段";
  const utcHour = new Date(ts).getUTCHours();
  // 盘前：UTC 08:00 - 13:30 (大约) → EDT 04:00 - 09:30 / EST 03:00 - 08:30
  if (utcHour >= 8 && utcHour < 13) return "盘前";
  // 盘后：UTC 20:00 - 次日 02:00 → EDT 16:00 - 22:00 / EST 15:00 - 21:00
  if (utcHour >= 20 || utcHour < 2) return "盘后";
  return "延长时段";
}

interface LivePEAddonProps {
  basePE: number;
  livePE: number;
  sessionLabel: string;
}

function LivePEAddon({ basePE, livePE, sessionLabel }: LivePEAddonProps) {
  const pct = ((livePE - basePE) / basePE) * 100;
  const isUp = livePE > basePE;
  const arrow = isUp ? "↑" : livePE < basePE ? "↓" : "·";
  // 颜色约定：PE 走高 → "更贵"（红）；PE 走低 → "更便宜"（绿）。
  // 与卡片本身的 text-expensive / text-cheap 一致，跨涨跌方向与"贵/便宜"语义自洽。
  const colorCls = isUp
    ? "text-expensive"
    : livePE < basePE
      ? "text-cheap"
      : "text-neutral";
  return (
    <>
      <div className={`metric-card__live ${colorCls}`}>
        <span>实时 {formatPE(livePE)}</span>
        <span className="metric-card__live-delta">
          {arrow} {Math.abs(pct).toFixed(2)}%
        </span>
      </div>
      <div className="metric-card__live-source">{sessionLabel} · 来自雪球</div>
    </>
  );
}

export function MetricsCards({
  metrics,
  currentIsLoss,
  latestSeriesDate,
  live,
}: MetricsCardsProps) {
  const lossPctText = `${(metrics.loss_ratio * 100).toFixed(1)}% 时间在亏损`;
  const percentileCls = percentileClass(metrics.current_percentile);
  const closeDateText = formatCloseDate(latestSeriesDate);

  // 实时 PE 只在亏损态以外、且雪球返回有效的盘前/盘后 PE 时展示。
  const showLive =
    !currentIsLoss &&
    live !== null &&
    live.is_extended_hours === true &&
    live.pe_ttm_ext !== null &&
    Number.isFinite(live.pe_ttm_ext) &&
    Number.isFinite(live.pe_ttm) &&
    live.pe_ttm > 0;

  return (
    <div className="metrics-grid" aria-label="指标卡片">
      <div className="metric-card">
        <div className="metric-label">当前 PE-TTM</div>
        {currentIsLoss ? (
          <>
            <div className="metric-value text-expensive">亏损中</div>
            <div className="metric-sub">无法计算</div>
          </>
        ) : (
          <>
            <div className="metric-value">{formatPE(metrics.current_pe)}</div>
            {closeDateText ? (
              <div className="metric-card__subtitle">{closeDateText}</div>
            ) : (
              <div className="metric-sub">{lossPctText}</div>
            )}
            {showLive && live ? (
              <LivePEAddon
                basePE={live.pe_ttm}
                livePE={live.pe_ttm_ext as number}
                sessionLabel={extendedSessionLabel(live.snapshot_at)}
              />
            ) : null}
          </>
        )}
      </div>

      <div className="metric-card">
        <div className="metric-label">历史中位 PE</div>
        <div className="metric-value">{formatPE(metrics.median_pe)}</div>
        <div className="metric-sub">剔除亏损期后</div>
      </div>

      <div className="metric-card">
        <div className="metric-label">当前分位</div>
        <div className={`metric-value ${percentileCls}`}>
          {formatPercentile(metrics.current_percentile)}
        </div>
        <div className="metric-sub">
          {percentileLabel(metrics.current_percentile) || lossPctText}
        </div>
      </div>

      <div className="metric-card">
        <div className="metric-label">历史极值</div>
        <div className="metric-value small">
          {formatPE(metrics.min_pe)} – {formatPE(metrics.max_pe)}
        </div>
        <div className="metric-sub">min – max</div>
      </div>
    </div>
  );
}

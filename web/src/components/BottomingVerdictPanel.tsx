import type { BottomingBlock, BottomingSign } from "../types";

interface BottomingVerdictPanelProps {
  bottoming: BottomingBlock;
}

const STATE_TONE: Record<BottomingSign["state"], "default" | "warning" | "success"> = {
  absent: "default",
  early: "warning",
  clear: "success",
};

/**
 * 筑底迹象判读面板：聚合结论 + 洗盘干净度 + 三迹象卡片。
 * 报告首屏主结论区；payload 缺失 bottoming 时由调用方跳过渲染。
 */
export function BottomingVerdictPanel({ bottoming }: BottomingVerdictPanelProps) {
  return (
    <section className="bottoming-panel" aria-label="筑底迹象判读">
      <div className="bottoming-head">
        <div className="bottoming-verdict">
          <span className="section-label">筑底迹象判读</span>
          <h2>
            <span className="bottoming-icon" aria-hidden="true">
              {bottoming.icon}
            </span>
            {bottoming.tier_label}
          </h2>
          <p className="bottoming-action">{bottoming.action}</p>
        </div>
        <div className="cleanliness-meter">
          <div className="meter-head">
            <span>{bottoming.cleanliness_label}</span>
            <strong>{bottoming.cleanliness_pct}%</strong>
          </div>
          <div className="meter-track">
            <span style={{ width: `${bottoming.cleanliness_pct}%` }} />
          </div>
          <p className="cleanliness-caption">{bottoming.cleanliness_caption}</p>
        </div>
      </div>

      <div className="bottoming-signs">
        {bottoming.signs.map((sign) => (
          <BottomingSignCard key={sign.id} sign={sign} />
        ))}
      </div>

      <div className="bottoming-next">
        <span className="section-label">下一步</span>
        <strong>{bottoming.next_trigger}</strong>
      </div>
    </section>
  );
}

function BottomingSignCard({ sign }: { sign: BottomingSign }) {
  const tone = STATE_TONE[sign.state] ?? "default";
  return (
    <article className={`bottoming-sign-card ${tone}`}>
      <div className="bottoming-sign-head">
        <div>
          <strong>{sign.name}</strong>
          <span className="plain-name">“{sign.plain_name}”</span>
        </div>
        <span className={`status-chip ${tone}`}>
          <i aria-hidden="true" />
          {sign.state_label} · {sign.score_pct}%
        </span>
      </div>
      <p className="bottoming-sign-desc">{sign.description}</p>
      {sign.dimensions.length > 0 ? (
        <div className="bottoming-dims">
          {sign.dimensions.map((dim) => (
            <span key={dim.key} title={dim.detail ?? undefined}>
              {dim.label} {Math.round((dim.score ?? 0) * 100)}%
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

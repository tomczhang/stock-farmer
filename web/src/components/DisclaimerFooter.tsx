/**
 * 底部免责角标：始终可见，附上版本号 + commit hash。
 */

export function DisclaimerFooter() {
  return (
    <footer className="app-footer">
      <div className="footer-row">
        <span>
          基于最新可得财报数据，不还原历史时点；亏损期已从分位计算中剔除。
        </span>
        <span className="version">
          v{__APP_VERSION__}-{__BUILD_COMMIT__}
        </span>
      </div>
      <div className="footer-row footer-row--sub">
        <span>
          历史分位基于日收盘 PE 计算；实时 PE 仅为参考，不参与分位分析。
        </span>
      </div>
    </footer>
  );
}

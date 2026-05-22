/**
 * 顶级布局：
 *   - 桌面：左侧 250px sidebar 常驻，右侧主区域。
 *   - 移动（<768px）：sidebar 折叠为抽屉，顶部 header 含汉堡菜单。
 *   - 底部 footer 由 DisclaimerFooter 提供。
 *
 * 抽屉开关状态由父组件传入，方便点击 watchlist 项时自动收起。
 */

import type { ReactNode } from "react";

import { DisclaimerFooter } from "./DisclaimerFooter";

export interface LayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  drawerOpen: boolean;
  onDrawerToggle: (open: boolean) => void;
  title?: string;
}

export function Layout({
  sidebar,
  main,
  drawerOpen,
  onDrawerToggle,
  title = "价值观察站",
}: LayoutProps) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <button
          type="button"
          className="hamburger"
          aria-label="切换 watchlist 抽屉"
          aria-expanded={drawerOpen}
          onClick={() => onDrawerToggle(!drawerOpen)}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
        </button>
        <h1>{title}</h1>
      </header>

      <div className="app-body">
        {drawerOpen ? (
          <div
            className="drawer-overlay"
            role="presentation"
            onClick={() => onDrawerToggle(false)}
          />
        ) : null}
        <aside className={`app-sidebar${drawerOpen ? " open" : ""}`}>
          {sidebar}
        </aside>
        <main className="app-main">{main}</main>
      </div>

      <DisclaimerFooter />
    </div>
  );
}

import { Suspense, createContext, lazy, useContext, useEffect, useState } from "react";
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useNavigate,
} from "react-router-dom";
import { api } from "./api";
import { isPrivacyOn, setPrivacy } from "./components/Chart";
import type { Me } from "./types";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import HoldingsPage from "./pages/HoldingsPage";
import PlansPage from "./pages/PlansPage";
import CashFlowsPage from "./pages/CashFlowsPage";

const DataPage = lazy(() => import("./pages/DataPage"));
const NotesPage = lazy(() => import("./pages/NotesPage"));
const PerformancePage = lazy(() => import("./pages/PerformancePage"));
const ReviewsPage = lazy(() => import("./pages/ReviewsPage"));
const WatchlistPage = lazy(() => import("./pages/WatchlistPage"));

interface AuthState {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  me: null,
  loading: true,
  refresh: async () => {},
  logout: async () => {},
});

export const useAuth = () => useContext(AuthContext);

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      setMe(await api.get<Me>("/api/auth/me"));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    await api.post("/api/auth/logout");
    setMe(null);
  };

  useEffect(() => {
    void refresh();
  }, []);

  return <AuthContext.Provider value={{ me, loading, refresh, logout }}>{children}</AuthContext.Provider>;
}

function Layout() {
  const { me, loading, logout } = useAuth();
  const navigate = useNavigate();
  const [privacy, setPrivacyState] = useState(isPrivacyOn());

  const togglePrivacy = () => {
    const next = !privacy;
    setPrivacy(next);
    setPrivacyState(next);
  };

  if (loading) {
    return (
      <div className="auth-wrap">
        <span className="spin dark" />
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace />;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="logo">
            <span className="dot" />
            价值观察站 · 资产盘点
          </Link>
          <nav className="topnav">
            <NavLink to="/" end>
              资产总览
            </NavLink>
            <NavLink to="/performance">绩效</NavLink>
            <NavLink to="/reviews">复盘</NavLink>
            <NavLink to="/holdings">持仓分析</NavLink>
            <NavLink to="/cashflows">现金流</NavLink>
            <NavLink to="/plans">加仓计划</NavLink>
            <NavLink to="/watchlist">观察</NavLink>
            <NavLink to="/notes">笔记本</NavLink>
            <NavLink to="/data">数据管理</NavLink>
          </nav>
          <div className="user">
            <button
              className={`btn ghost sm privacy-btn ${privacy ? "privacy-on" : ""}`}
              title={privacy ? "关闭防窥模式，显示金额" : "开启防窥模式，隐藏金额"}
              aria-pressed={privacy}
              onClick={togglePrivacy}
            >
              {privacy ? (
                // 闭眼（防窥中）：线性 SVG，不用 emoji 图标
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                  <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
              {privacy ? "防窥中" : "防窥"}
            </button>
            <span>{me.email}</span>
            <button
              className="btn ghost sm"
              onClick={async () => {
                await logout();
                navigate("/login");
              }}
            >
              退出
            </button>
          </div>
        </div>
      </header>
      {/* privacy 变化时重新挂载页面，确保 useMemo 的图表配置也按新口径重算 */}
      <main className="page" key={privacy ? "privacy" : "plain"}>
        <Outlet />
      </main>
    </>
  );
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <DashboardPage /> },
      {
        path: "performance",
        element: (
          <Suspense fallback={<div className="empty"><span className="spin dark" aria-label="正在加载绩效" /></div>}>
            <PerformancePage />
          </Suspense>
        ),
      },
      {
        path: "reviews",
        element: (
          <Suspense fallback={<div className="empty"><span className="spin dark" aria-label="正在加载复盘" /></div>}>
            <ReviewsPage />
          </Suspense>
        ),
      },
      { path: "holdings", element: <HoldingsPage /> },
      { path: "cashflows", element: <CashFlowsPage /> },
      { path: "statements", element: <Navigate to="/data" replace /> },
      { path: "plans", element: <PlansPage /> },
      {
        path: "watchlist",
        element: (
          <Suspense fallback={<div className="empty"><span className="spin dark" aria-label="正在加载观察窗口" /></div>}>
            <WatchlistPage />
          </Suspense>
        ),
      },
      {
        path: "notes",
        element: (
          <Suspense fallback={<div className="empty"><span className="spin dark" aria-label="正在加载笔记本" /></div>}>
            <NotesPage />
          </Suspense>
        ),
      },
      {
        path: "data",
        element: (
          <Suspense fallback={<div className="empty"><span className="spin dark" aria-label="正在加载数据管理" /></div>}>
            <DataPage />
          </Suspense>
        ),
      },
    ],
  },
], { future: { v7_relativeSplatPath: true } });

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </AuthProvider>
  );
}

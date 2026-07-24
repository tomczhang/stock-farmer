import { createContext, useContext, useEffect, useState } from "react";
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
import type { Me } from "./types";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import StatementsPage from "./pages/StatementsPage";
import PlansPage from "./pages/PlansPage";

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
              资产盘点
            </NavLink>
            <NavLink to="/statements">月结单</NavLink>
            <NavLink to="/plans">加仓计划</NavLink>
          </nav>
          <div className="user">
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
      <main className="page">
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
      { path: "statements", element: <StatementsPage /> },
      { path: "plans", element: <PlansPage /> },
    ],
  },
]);

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}

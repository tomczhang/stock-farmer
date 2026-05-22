/**
 * React 入口：挂载到 index.html 中的 #root，并加载全局样式。
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 容器，无法挂载 React 应用");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

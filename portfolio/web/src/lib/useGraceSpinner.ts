import { useEffect, useState } from "react";

/**
 * 首屏加载宽限（interior.dev 时序纪律）：busy 持续超过 grace 毫秒才显示 spinner。
 * 本地/快速请求在宽限期内完成，用户全程看不到转圈——这是消除切页闪动的关键一环。
 */
export function useGraceSpinner(active: boolean, grace = 220): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!active) {
      setShow(false);
      return;
    }
    const timer = window.setTimeout(() => setShow(true), grace);
    return () => window.clearTimeout(timer);
  }, [active, grace]);
  return show;
}

import { useEffect, useState } from "react";

export function useMobileDetect() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 780px)").matches);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 780px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return { isMobile };
}

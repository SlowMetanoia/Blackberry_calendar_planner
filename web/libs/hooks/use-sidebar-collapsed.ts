import { useCallback, useState } from "react";

const STORAGE_KEY = "planner-sidebar-collapsed";

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(STORAGE_KEY) === "true",
  );

  const toggle = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return { collapsed, toggle };
}

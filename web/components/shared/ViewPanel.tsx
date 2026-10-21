import { useEffect, useState, type ReactNode } from "react";

export function ViewPanel({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(active);

  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);

  if (!visited) return null;

  return (
    <div className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      {children}
    </div>
  );
}

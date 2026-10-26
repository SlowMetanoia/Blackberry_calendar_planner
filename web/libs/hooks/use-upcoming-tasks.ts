import { useEffect, useMemo, useState } from "react";
import { getTasks } from "../../api";
import type { Task } from "../../types";
import { collectPages } from "../pagination";
import { useSessionStore } from "../stores";

const HORIZON_DAYS = 7;

export type UpcomingTask = {
  task: Task;
  deadline: number;
  overdue: boolean;
};

export function useUpcomingTasks(days = HORIZON_DAYS) {
  const revision = useSessionStore((state) => state.calendarRevision);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const result = await collectPages((offset) =>
          getTasks({
            offset,
            status: "open",
            deadlinePresence: "dated",
          }),
        );
        if (!cancelled) setTasks(result);
      } catch {
        if (!cancelled) {
          setTasks([]);
          setError("Не удалось загрузить задачи.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const items = useMemo<UpcomingTask[]>(() => {
    const now = Date.now();
    const horizon = now + days * 86_400_000;
    return tasks
      .map((task) => ({
        task,
        deadline: task.deadline ? Date.parse(task.deadline) : Number.NaN,
      }))
      .filter(
        (item) =>
          Number.isFinite(item.deadline) && item.deadline < horizon,
      )
      .sort(
        (left, right) =>
          left.deadline - right.deadline ||
          left.task.title.localeCompare(right.task.title, "ru"),
      )
      .map((item) => ({ ...item, overdue: item.deadline < now }));
  }, [tasks, days]);

  return { items, loading, error };
}

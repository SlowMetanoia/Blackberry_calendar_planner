import type { CollisionOccurrence, CollisionReport } from "../../types";
import { formatSchedule } from "../../libs/format";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";

function Occurrence({ item }: { item: CollisionOccurrence }) {
  return <p><strong>{item.data.title}</strong> — {formatSchedule(item.scheduled_at, item.data.duration_minutes)}
    {item.data.duration_minutes == null && " (длительность неизвестна)"}</p>;
}

export function CollisionWarning({ report, onClose }: {
  report: CollisionReport; onClose: () => void;
}) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto border-amber-400" closeLabel="Закрыть предупреждение">
      <DialogHeader><DialogTitle>Событие сохранено. Есть пересечения</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">Пересечение по времени может быть допустимым. Проверьте расписание.</p>
      {report.groups.map((group) => <section key={group.id} className="grid gap-2 rounded border border-amber-300 p-3 text-sm">
        <Occurrence item={group.occurrences[0].first} />
        <Occurrence item={group.occurrences[0].second} />
        {group.occurrences.length > 1 && <details>
          <summary>Всего пересечений: {group.occurrences.length}. Все даты</summary>
          {group.occurrences.slice(1).map((pair) => <div className="mt-2 border-t pt-2" key={`${pair.first.occurrence_key}:${pair.second.occurrence_key}`}>
            <Occurrence item={pair.first} /><Occurrence item={pair.second} />
          </div>)}
        </details>}
      </section>)}
      {report.checked_from && report.checked_to && <p className="text-xs text-muted-foreground">
        Проверен период: {formatSchedule(report.checked_from, null)} — {formatSchedule(report.checked_to, null)}
      </p>}
    </DialogContent>
  </Dialog>;
}

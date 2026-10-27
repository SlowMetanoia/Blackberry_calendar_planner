import {
  operationWords,
  resourceHeadings,
  resourceMetadata,
  stringField,
} from "../../libs/calendar-view";
import type { EntryRef } from "../../libs/entry-loader";
import type { CalendarOperation } from "../../types";
import { Badge } from "../ui/badge";
import { ResourceCard } from "../shared/ResourceCard";

export function OperationReceipt({
  item,
  onOpenRecord,
}: {
  item: CalendarOperation;
  onOpenRecord?: (ref: EntryRef) => void;
}) {
  const data = item.after || item.before || {};
  // A deleted record has nothing left to edit.
  const openable = Boolean(onOpenRecord) && item.operation !== "delete";
  return (
    <ResourceCard
      className="mt-3 gap-2.5 shadow-none ring-border/70"
      badge={
        <Badge
          variant={item.operation === "delete" ? "destructive" : "secondary"}
          className="w-fit"
        >
          {operationWords[item.operation]} · {resourceHeadings[item.resource]}
          {item.scope === "occurrence" ? " · один повтор" : ""}
        </Badge>
      }
      title={stringField(data, "title") || item.target_id}
      metadata={resourceMetadata(item.resource, data)}
      changes={item.operation === "update" ? item.changes : undefined}
      onOpen={
        openable
          ? () =>
              onOpenRecord?.({
                resource: item.resource,
                id: item.target_id,
                occurrenceKey:
                  item.scope === "occurrence" ? item.occurrence_key : null,
                snapshot: item.after,
              })
          : undefined
      }
    />
  );
}

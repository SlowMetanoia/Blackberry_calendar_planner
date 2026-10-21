import {
  operationWords,
  resourceHeadings,
  resourceMetadata,
  stringField,
} from "../../libs/calendar-view";
import type { CalendarOperation } from "../../types";
import { Badge } from "../ui/badge";
import { ResourceCard } from "../shared/ResourceCard";

export function OperationReceipt({ item }: { item: CalendarOperation }) {
  const data = item.after || item.before || {};
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
    />
  );
}

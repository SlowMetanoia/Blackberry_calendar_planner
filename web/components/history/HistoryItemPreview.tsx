import {
  operationWords,
  resourceMetadata,
} from "../../libs/calendar-view";
import type { CalendarOperation } from "../../types";
import { Badge } from "../ui/badge";
import { ResourceCard } from "../shared/ResourceCard";

export function HistoryItemPreview({
  item,
  title,
}: {
  item: CalendarOperation;
  title: string;
}) {
  const data = item.after || item.before || {};
  return (
    <ResourceCard
      className="w-80 shadow-lg ring-border"
      badge={
        <Badge
          variant={item.operation === "delete" ? "destructive" : "secondary"}
          className="w-fit"
        >
          {operationWords[item.operation]}
        </Badge>
      }
      title={title}
      metadata={resourceMetadata(item.resource, data)}
      changes={item.operation === "update" ? item.changes : undefined}
      footer={
        <>
          Источник: {item.origin}
          {item.reverts_operation_id ? " · компенсирующая операция" : ""}
        </>
      }
    />
  );
}

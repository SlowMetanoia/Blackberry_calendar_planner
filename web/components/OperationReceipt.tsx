import {
  operationWords,
  resourceHeadings,
  resourceMetadata,
  stringField,
} from "../libs/calendar-view";
import type { CalendarOperation } from "../types";
import { Changes } from "./Changes";
import { Metadata } from "./Metadata";

export function OperationReceipt({ item }: { item: CalendarOperation }) {
  const data = item.after || item.before || {};
  return (
    <article className="read-card operation-receipt">
      <span className="read-kind">
        {operationWords[item.operation]} · {resourceHeadings[item.resource]}
        {item.scope === "occurrence" ? " · один повтор" : ""}
      </span>
      <strong>{stringField(data, "title") || item.target_id}</strong>
      <Metadata items={resourceMetadata(item.resource, data)} />
      {item.operation === "update" && <Changes changes={item.changes} />}
    </article>
  );
}

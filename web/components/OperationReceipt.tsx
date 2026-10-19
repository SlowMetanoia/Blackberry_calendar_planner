import {
  operationWords,
  resourceHeadings,
  resourceMetadata,
  stringField,
} from "../libs/calendar-view";
import type { CalendarOperation } from "../types";
import { Badge } from "./ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Separator } from "./ui/separator";
import { Changes } from "./Changes";
import { Metadata } from "./Metadata";

export function OperationReceipt({ item }: { item: CalendarOperation }) {
  const data = item.after || item.before || {};
  return (
    <Card size="sm" className="mt-3 gap-2.5 shadow-none ring-border/70">
      <CardHeader className="gap-1.5">
        <Badge
          variant={item.operation === "delete" ? "destructive" : "secondary"}
          className="w-fit"
        >
          {operationWords[item.operation]} · {resourceHeadings[item.resource]}
          {item.scope === "occurrence" ? " · один повтор" : ""}
        </Badge>
        <CardTitle className="text-sm">
          {stringField(data, "title") || item.target_id}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <Metadata items={resourceMetadata(item.resource, data)} />
        {item.operation === "update" && (
          <>
            <Separator />
            <Changes changes={item.changes} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

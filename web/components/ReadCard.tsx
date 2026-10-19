import {
  resourceHeadings,
  resourceMetadata,
  stringField,
} from "../libs/calendar-view";
import { browserTimeZone } from "../libs/format";
import type { DisplayItem } from "../types";
import { Badge } from "./ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Metadata } from "./Metadata";

export function ReadCard({
  read,
  timeZone = browserTimeZone(),
}: {
  read: DisplayItem;
  timeZone?: string;
}) {
  return (
    <Card size="sm" className="mt-3 gap-2.5 shadow-none ring-border/70">
      <CardHeader className="gap-1.5">
        <Badge variant="secondary" className="w-fit">
          {resourceHeadings[read.resource] || read.resource}
        </Badge>
        <CardTitle className="text-sm">
          {stringField(read.data, "title") || read.id}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Metadata items={resourceMetadata(read.resource, read.data, timeZone)} />
      </CardContent>
    </Card>
  );
}

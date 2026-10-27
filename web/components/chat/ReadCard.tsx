import { browserTimeZone } from "../../libs/format";
import {
  resourceHeadings,
  resourceMetadata,
  stringField,
} from "../../libs/calendar-view";
import type { EntryRef } from "../../libs/entry-loader";
import type { DisplayItem, Resource } from "../../types";
import { Badge } from "../ui/badge";
import { ResourceCard } from "../shared/ResourceCard";

export function ReadCard({
  read,
  timeZone = browserTimeZone(),
  onOpenRecord,
}: {
  read: DisplayItem;
  timeZone?: string;
  onOpenRecord?: (ref: EntryRef) => void;
}) {
  const occurrenceKey = read.data.occurrence_key;
  return (
    <ResourceCard
      className="mt-3 gap-2.5 shadow-none ring-border/70"
      badge={
        <Badge variant="secondary" className="w-fit">
          {resourceHeadings[read.resource] || read.resource}
        </Badge>
      }
      title={stringField(read.data, "title") || read.id}
      metadata={resourceMetadata(read.resource, read.data, timeZone)}
      onOpen={
        onOpenRecord
          ? () =>
              onOpenRecord({
                resource: read.resource as Resource,
                id: read.id,
                occurrenceKey:
                  typeof occurrenceKey === "string" ? occurrenceKey : null,
                snapshot: read.data,
              })
          : undefined
      }
    />
  );
}

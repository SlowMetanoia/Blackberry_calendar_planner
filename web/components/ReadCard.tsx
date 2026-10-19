import {
  resourceHeadings,
  resourceMetadata,
  stringField,
} from "../libs/calendar-view";
import { browserTimeZone } from "../libs/format";
import type { DisplayItem } from "../types";
import { Metadata } from "./Metadata";

export function ReadCard({
  read,
  timeZone = browserTimeZone(),
}: {
  read: DisplayItem;
  timeZone?: string;
}) {
  return (
    <article className="read-card">
      <span className="read-kind">
        {resourceHeadings[read.resource] || read.resource}
      </span>
      <strong>{stringField(read.data, "title") || read.id}</strong>
      <Metadata items={resourceMetadata(read.resource, read.data, timeZone)} />
    </article>
  );
}

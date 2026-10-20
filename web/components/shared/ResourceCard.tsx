import type { ReactNode } from "react";
import type { CalendarOperation, ResourceMetadataItem } from "../../types";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Separator } from "../ui/separator";
import { Changes } from "./Changes";
import { Metadata } from "./Metadata";

export function ResourceCard({
  badge,
  title,
  metadata,
  changes,
  footer,
  className = "",
}: {
  badge: ReactNode;
  title: string;
  metadata: ResourceMetadataItem[];
  changes?: CalendarOperation["changes"];
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Card size="sm" className={className}>
      <CardHeader className="gap-1.5">
        {badge}
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <Metadata items={metadata} />
        {changes && (
          <>
            <Separator />
            <Changes changes={changes} />
          </>
        )}
      </CardContent>
      {footer && (
        <CardFooter className="py-2 text-[11px] text-muted-foreground">
          {footer}
        </CardFooter>
      )}
    </Card>
  );
}

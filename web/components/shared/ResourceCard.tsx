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
  onOpen,
}: {
  badge: ReactNode;
  title: string;
  metadata: ResourceMetadataItem[];
  changes?: CalendarOperation["changes"];
  footer?: ReactNode;
  className?: string;
  onOpen?: () => void;
}) {
  return (
    <Card
      size="sm"
      className={`${className} ${
        onOpen
          ? "relative cursor-pointer transition-colors hover:bg-muted/50 has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-ring/50"
          : ""
      }`}
    >
      {onOpen && (
        <button
          type="button"
          aria-label={`Открыть «${title}»`}
          className="absolute inset-0 z-10 rounded-[inherit] outline-none"
          onClick={onOpen}
        />
      )}
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

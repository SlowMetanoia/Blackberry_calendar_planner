import { Card, CardContent } from "../ui/card";
import { MessageTime } from "./MessageTime";

export function UserMessage({
  text,
  createdAt,
}: {
  text: string;
  createdAt: string;
}) {
  return (
    <Card
      size="sm"
      className="bubble user relative ml-auto max-w-[82%] gap-0 rounded-br-sm bg-primary px-4 pt-3.5 pb-7 text-primary-foreground ring-primary/20"
    >
      <CardContent className="px-0 text-sm leading-relaxed whitespace-pre-wrap">
        {text}
      </CardContent>
      <MessageTime
        value={createdAt}
        className="absolute right-4 bottom-2.5 text-primary-foreground/65"
      />
    </Card>
  );
}

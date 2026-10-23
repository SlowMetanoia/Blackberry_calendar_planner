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
      className="bubble user relative ml-auto min-w-[8.5rem] max-w-[88%] gap-0 rounded-br-sm bg-primary px-3.5 pt-3 pb-7 break-words text-primary-foreground ring-primary/20 sm:max-w-[82%] sm:px-4 sm:pt-3.5"
    >
      <CardContent className="min-w-0 px-0 text-sm leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </CardContent>
      <MessageTime
        value={createdAt}
        className="absolute right-3.5 bottom-2.5 text-primary-foreground/65 sm:right-4"
      />
    </Card>
  );
}

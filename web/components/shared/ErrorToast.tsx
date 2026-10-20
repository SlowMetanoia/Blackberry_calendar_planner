import { XIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

export function ErrorToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  if (!message) return null;

  return (
    <Alert
      variant="destructive"
      className="fixed top-4 left-1/2 z-[120] w-auto max-w-[calc(100vw-2rem)] -translate-x-1/2 bg-popover shadow-lg"
    >
      <AlertDescription>{message}</AlertDescription>
      <AlertAction>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Закрыть уведомление"
          onClick={onDismiss}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </AlertAction>
    </Alert>
  );
}

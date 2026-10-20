import { formatMessageTimestamp } from "../../libs/format";

export function MessageTime({
  value,
  className = "",
}: {
  value: string;
  className?: string;
}) {
  const label = formatMessageTimestamp(value);
  return label ? (
    <time className={`text-[11px] leading-none ${className}`} dateTime={value}>
      {label}
    </time>
  ) : null;
}

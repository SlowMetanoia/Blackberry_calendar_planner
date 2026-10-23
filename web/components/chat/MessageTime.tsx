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
    <time
      className={`whitespace-nowrap text-[11px] leading-none tabular-nums ${className}`}
      dateTime={value}
    >
      {label}
    </time>
  ) : null;
}

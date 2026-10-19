import type { ResourceMetadataItem } from "../types";

export function Metadata({ items }: { items: ResourceMetadataItem[] }) {
  return items.length ? (
    <dl className="grid gap-1 text-xs leading-relaxed text-muted-foreground">
      {items.map((item, index) => (
        <div className="flex flex-wrap gap-1" key={`${item.label ?? "value"}-${index}`}>
          {item.label && (
            <dt className="font-medium text-foreground/80">{item.label}:</dt>
          )}
          <dd className="m-0">{item.value}</dd>
        </div>
      ))}
    </dl>
  ) : null;
}

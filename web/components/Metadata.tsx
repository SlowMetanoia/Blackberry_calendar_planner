import type { ResourceMetadataItem } from "../types";

export function Metadata({ items }: { items: ResourceMetadataItem[] }) {
  return items.length ? (
    <dl className="resource-metadata">
      {items.map((item, index) => (
        <div key={index}>
          {item.label && <dt>{item.label}:</dt>}
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  ) : null;
}

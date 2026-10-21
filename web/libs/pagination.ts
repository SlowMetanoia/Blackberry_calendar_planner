import type { Page } from "../types";

export async function collectPages<T>(
  load: (offset: number) => Promise<Page<T>>,
): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; ; ) {
    const page = await load(offset);
    result.push(...page.items);

    offset += page.items.length;
    if (offset >= page.total || !page.items.length) {
      return result;
    }
  }
}

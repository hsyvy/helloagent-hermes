/** Quick probe for "is any account paired?" — used by `status` and `run`. */
import { listLinkedAccountIds } from "./store.js";

export async function hasAnyAuth(): Promise<boolean> {
  const ids = await listLinkedAccountIds();
  return ids.length > 0;
}

// Test seam for modules/insight.ts. Deliberately NOT exported from modules/index.ts,
// so it is not part of the public surface. Tests import it directly.
export interface Request { system: string; input: string; schema: Record<string, unknown> }
export type Complete = (req: Request) => Promise<{ data: unknown; model: string }>;
export const seam: { complete?: Complete } = {};
/** Replace the model call (no key, no network). Pass undefined to restore. */
export const setComplete = (fn?: Complete) => { seam.complete = fn; };

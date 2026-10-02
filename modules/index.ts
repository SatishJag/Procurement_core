import { Platform, type Seed } from '../core/kernel.ts';
import * as contracts from './contracts.ts';

// The module registry. A new capability = one file in modules/, one export
// line here, and its event subscriptions in createPlatform.
export * as awards from './awards.ts';
export * as contracts from './contracts.ts';
export * as evaluation from './evaluation.ts';
export * as intake from './intake.ts';
export * as planning from './planning.ts';
export * as reporting from './reporting.ts';
export * as sourcing from './sourcing.ts';
export * as suppliers from './suppliers.ts';
export { Platform, type Seed };

export function createPlatform(seed: Seed, clock?: () => string) {
  const p = new Platform(seed, clock);
  p.on('award.approved', contracts.draftFromAward);
  return p;
}

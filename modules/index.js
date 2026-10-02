import { Platform } from '../core/kernel.js';
import * as contracts from './contracts.js';
// The module registry. A new capability = one file in modules/, one export
// line here, and its event subscriptions in createPlatform.
export * as awards from './awards.js';
export * as contracts from './contracts.js';
export * as evaluation from './evaluation.js';
export * as intake from './intake.js';
export * as planning from './planning.js';
export * as reporting from './reporting.js';
export * as sourcing from './sourcing.js';
export * as suppliers from './suppliers.js';
export { Platform };
export function createPlatform(seed, clock) {
    const p = new Platform(seed, clock);
    p.on('award.approved', contracts.draftFromAward);
    return p;
}

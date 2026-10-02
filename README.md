# @satishjag/procurement-core

Source-to-Contract engine: capability core for procurement platforms (data centres, construction). Phase 1 includes procurement planning through award, supplier onboarding, technical and commercial evaluation, and contract handoff.

## Install

```bash
npm install @satishjag/procurement-core
```

Requires Node 22.18+. TypeScript runs directly; no build step. Zero runtime dependencies (`@anthropic-ai/sdk` is an optional peer, used only by `insight` when `ANTHROPIC_API_KEY` is set).

## Usage

```typescript
import { Platform } from '@satishjag/procurement-core/core';
import * as intake from '@satishjag/procurement-core/modules';

const p = new Platform(seed);
const req = intake.submit(p, user, {...});
```

## API

- **`core/kernel.ts`**: Platform class (tables, clock, id generation, event bus)
- **`core/types.ts`**: Shared data objects (User, Project, Package, Supplier, Award, etc.)
- **`core/workflow.ts`**: Table-driven state machines, access control
- **`modules/index.ts`**: All commands (intake, suppliers, sourcing, evaluation, awards, contracts, reporting)

## Capabilities (Phase 1)

| Capability | Module | What's enforced |
|---|---|---|
| Guided intake | `intake` | Free text → requisition → package with category, route, budget check |
| BOQ upload | `intake` | CSV import, lot/item extraction, reusable templates |
| Planning | `planning` | Backward schedule from need-by date; long-lead flagging |
| Suppliers | `suppliers` | Registration, qualification, eligibility, discovery ranking |
| Sourcing | `sourcing` | RFx, BOQ, clarifications, sealed bids (audit holds SHA-256 seal, not prices) |
| Evaluation | `evaluation` | Two-envelope (technical then commercial), blind scoring, consensus moderation |
| AI insight | `insight` | Advisory only: Claude second opinion on requisition category and bid-evaluation risks; same guards as the engines (sealed envelope, roles, project), evidence-cited risks only, `insight.generated` audit event. Optional `@anthropic-ai/sdk` + `ANTHROPIC_API_KEY`; no key = rule-based result |
| Awards | `awards` | Delegation-of-authority bands, sequential approval, SoD |
| Contracts | `contracts` | Draft per award, triggered by award.approved event |
| Audit | `audit` | Append-only, hash-chained, tamper-evident |

## Development

```bash
npm test                    # 11 checks
npm run typecheck
```

## Publishing

```bash
npm version patch           # or minor / major
git push origin main --tags
npm publish
```

## License

MIT

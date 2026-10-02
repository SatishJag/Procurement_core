import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recommend, uploadBoq, createPackagesFromBoq } from '../modules/intake.ts';
import { schedule } from '../modules/planning.ts';
import { createPlatform } from '../modules/index.ts';

test('intake and planning: route by value and category, backward schedule', () => {
  assert.equal(recommend('Office stationery', 20_000).route, 'Direct PO');
  assert.equal(recommend('Commissioning agent advisory services', 200_000).route, 'RFP');
  const r = recommend('UPS batteries replacement', 3_000_000);
  assert.equal(r.category, 'Electrical / UPS');
  assert.equal(r.longLead, true);
  const s = schedule('2027-06-30', 'RFQ', 10, false, '2026-10-01');
  assert.deepEqual(s.milestones.map(m => m.date), ['2027-03-17', '2027-03-31', '2027-04-07', '2027-04-21', '2027-06-30']);
  assert.equal(s.health, 'on_track');
});

test('BOQ upload and package creation from template', () => {
  const seed = {
    tables: {
      users: [{ id: 'buyer-1', name: 'Buyer', roles: ['buyer' as const], projects: ['*'] }],
      projects: [{
        id: 'DC1', name: 'Test Project', site: 'Test', capacityMW: 24,
        budgets: { 'DC1.IT': 500_000 },
        committed: {},
      }],
      suppliers: [],
      packages: [],
    },
    fx: { AED: 1, USD: 3.6725 },
  };
  const p = createPlatform(seed as never);
  const buyer = p.users.get('buyer-1')!;

  const csvText = 'lot,item,unit,qty\nL1,Server Racks,nr,10\nL1,Patch Cables,m,500\nL2,Chillers,nr,2';
  const boq = uploadBoq(p, buyer, { projectId: 'DC1', name: 'DC1 Infrastructure', csvText });

  assert.equal(boq.lots.length, 2);
  assert.equal(boq.lines.length, 3);
  assert.equal(boq.id.startsWith('BOQ-'), true);

  const pkg = createPackagesFromBoq(p, buyer, {
    boqTemplateId: boq.id,
    costCode: 'DC1.IT',
    category: 'IT / Structured Cabling',
    estimate: 250_000,
    needBy: '2027-03-01',
    route: 'RFQ',
    longLead: false,
  });

  assert.equal(pkg.id.startsWith('PKG-'), true);
  assert.equal(pkg.title, 'DC1 Infrastructure');
  assert.equal(pkg.status, 'planned');
});

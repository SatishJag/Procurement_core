import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serve } from '../server/index.ts';

test('api: lists commands, runs one as the header user, rejects unknown users and internals', async () => {
  const server = serve(undefined, 0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const call = (path: string, user: string, args: unknown[]) =>
    fetch(`${base}/${path}`, { method: 'POST', headers: { 'x-user-id': user }, body: JSON.stringify({ args }) }).then(r => r.json());
  try {
    const list = await fetch(base).then(r => r.json());
    assert.ok(list.data.intake.includes('submit'));
    const ok = await call('reporting/dashboard', 'u-daniel', []);
    assert.equal(ok.data.pipeline.sourcing, 1);
    assert.equal((await call('reporting/dashboard', 'nobody', [])).error, 'Unknown user');
    assert.equal((await call('intake/recommend', 'u-omar', ['x', 1])).error, 'Unknown endpoint'); // pure helper, not a command
    assert.equal((await call('constructor/assign', 'u-omar', [{}])).error, 'Unknown endpoint');  // prototype members
    assert.equal((await call('intake/constructor', 'u-omar', [])).error, 'Unknown endpoint');
    assert.match((await call('awards/decide', 'u-omar', ['AW-1', 'approved'])).error, /not found|needs one of/);
  } finally {
    server.close();
  }
});

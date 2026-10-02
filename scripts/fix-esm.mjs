// tsc emits extensionless relative imports; Node ESM needs `./x.js`. Bare and `node:` specifiers are left alone.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
for (const dir of ['core', 'modules']) {
  for (const f of readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const src = readFileSync(`${dir}/${f}`, 'utf8');
    writeFileSync(`${dir}/${f}`, src.replace(/(from ')(\.{1,2}\/[^']*?)(?<!\.js)'/g, "$1$2.js'"));
  }
}

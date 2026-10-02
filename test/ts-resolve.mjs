// Sources import `../core/x` without an extension (tsc style); let Node run them as .ts directly.
import { registerHooks } from 'node:module';
registerHooks({
  resolve(spec, ctx, nextResolve) {
    try { return nextResolve(spec, ctx); } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND' && spec.startsWith('.')) return nextResolve(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

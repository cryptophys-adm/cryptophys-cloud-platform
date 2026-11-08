// node:test subset for the Forge runner: test(name, [opts], fn), test.skip, beforeEach/afterEach.
const reg = (globalThis.__TESTS ??= { tests: [], before: [], after: [] });
export function test(name, a, b) {
  const fn = typeof a === "function" ? a : b;
  const opts = a && typeof a === "object" ? a : {};
  reg.tests.push({ name, fn, skip: Boolean(opts.skip), todo: Boolean(opts.todo) });
}
test.skip = (name) => reg.tests.push({ name, skip: true });
test.todo = (name) => reg.tests.push({ name, todo: true });
export const it = test;
export function describe(_name, fn) { fn(); }
export function beforeEach(fn) { reg.before.push(fn); }
export function afterEach(fn) { reg.after.push(fn); }
export default test;

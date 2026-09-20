import { configure } from '@testing-library/react';

// Testing Library's `findBy*` queries and `waitFor` default to a 1000ms poll budget (asyncUtilTimeout).
// Under full-suite or concurrent-suite parallel load, jsdom worker threads can be starved of CPU by
// everything else running at once, occasionally pushing a normally-fast wait (e.g. for a debounced
// live-evaluation result) past that default. Raise it globally so every test gets real headroom
// without scattering per-call `{ timeout }` options; no assertion is weakened by this.
configure({ asyncUtilTimeout: 10_000 });

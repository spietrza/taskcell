import '@testing-library/jest-dom/vitest';

// The app keeps its screen in the address (`?screen=`): one test's navigation must not open the next test on that screen.
// (Some tests stub `window` or run without a history: nothing to reset there.)
afterEach(() => globalThis.window?.history?.replaceState(null, '', '/'));

// The time a test that runs real git gets (#210 F10).

/** A real-Git case starts several git processes and writes temp folders, which a loaded machine
 *  (another suite running beside it) stretches past Vitest's default 5 seconds. */
export const REAL_GIT_MS = 30_000;

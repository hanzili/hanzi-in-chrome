/**
 * End-to-end managed task test.
 *
 * Tests the full partner flow with a mock-connected session:
 *   1. Create API key
 *   2. Create pairing token with metadata
 *   3. Register session
 *   4. Task creation succeeds (session reports as connected)
 *   5. Task enters "running" state
 *
 * Limitation: cannot test actual agent loop execution (needs LLM + extension).
 * But this proves the full auth → pairing → session → task creation pipeline
 * with a connected session, which is the gap the other tests don't cover.
 */
export {};

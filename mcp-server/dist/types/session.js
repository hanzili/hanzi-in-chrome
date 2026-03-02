/**
 * Session Types
 *
 * Defines the session state machine and related types for browser automation tasks.
 */
/**
 * Valid state transitions for the session state machine.
 */
export const VALID_TRANSITIONS = {
    CREATED: ["EXECUTING", "FAILED", "CANCELLED"],
    EXECUTING: ["COMPLETED", "WAITING_FOR_USER", "FAILED", "CANCELLED"],
    WAITING_FOR_USER: ["EXECUTING", "FAILED", "CANCELLED"],
    COMPLETED: [], // Terminal state
    FAILED: [], // Terminal state
    CANCELLED: [], // Terminal state
};

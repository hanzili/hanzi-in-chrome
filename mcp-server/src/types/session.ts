/**
 * Session Types
 *
 * Defines the session state machine and related types for browser automation tasks.
 */

/**
 * All possible states a session can be in.
 *
 * State transitions:
 *   CREATED → EXECUTING → COMPLETED
 *                ↓
 *             WAITING_FOR_USER → EXECUTING
 *   Any state can transition to FAILED or CANCELLED
 */
export type SessionState =
  | "CREATED"           // Session just initialized
  | "EXECUTING"         // Browser agent running
  | "WAITING_FOR_USER"  // Needs user input to continue
  | "COMPLETED"         // Task finished successfully
  | "FAILED"            // Task failed (error)
  | "CANCELLED";        // User cancelled

/**
 * Valid state transitions for the session state machine.
 */
export const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  CREATED: ["EXECUTING", "FAILED", "CANCELLED"],
  EXECUTING: ["COMPLETED", "WAITING_FOR_USER", "FAILED", "CANCELLED"],
  WAITING_FOR_USER: ["EXECUTING", "FAILED", "CANCELLED"],
  COMPLETED: [],  // Terminal state
  FAILED: [],     // Terminal state
  CANCELLED: [],  // Terminal state
};

/**
 * A question to ask the user for missing information.
 */
export interface Question {
  /** Unique identifier for the question */
  id: string;
  /** The field/info this question is asking about (e.g., "email", "departure_date") */
  field: string;
  /** Human-readable question to display */
  question: string;
  /** Optional hint or example */
  hint?: string;
  /** Whether this is required or optional */
  required: boolean;
  /** Data type expected (for validation) */
  type?: "text" | "email" | "date" | "password" | "number" | "choice";
  /** For choice type, the available options */
  options?: string[];
}

/**
 * A single entry in the execution trace.
 */
export interface TraceEntry {
  timestamp: string;
  type:
    | "navigation"
    | "click"
    | "fill"
    | "screenshot"
    | "thinking"
    | "error"
    | "info";
  description: string;
  url?: string;
  selector?: string;
  value?: string;
  screenshot?: string;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Main session object tracking a browser automation task.
 */
export interface Session {
  id: string;
  state: SessionState;
  task: string;
  url?: string;
  context?: string;
  domain?: string;
  collectedInfo: Record<string, string>;
  pendingQuestions: Question[];
  executionTrace: TraceEntry[];
  currentStep?: string;
  answer?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

/**
 * Serializable session data for storage/transport.
 * Dates are converted to ISO strings.
 */
export interface SerializedSession {
  id: string;
  state: SessionState;
  task: string;
  url?: string;
  context?: string;
  domain?: string;
  collectedInfo: Record<string, string>;
  pendingQuestions: Question[];
  executionTrace: TraceEntry[];
  currentStep?: string;
  answer?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/**
 * Options for creating a new session.
 */
export interface CreateSessionOptions {
  task: string;
  url?: string;
  context?: string;
}

/**
 * Result of a state transition attempt.
 */
export interface TransitionResult {
  /** Whether the transition was successful */
  success: boolean;
  /** Previous state (if successful) */
  previousState?: SessionState;
  /** New state (if successful) */
  newState?: SessionState;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Session status for external API responses.
 * Simplified view of session state.
 */
export interface SessionStatus {
  sessionId: string;
  status: SessionState;
  task: string;
  domain?: string;
  currentStep?: string;
  /** Summary of steps taken */
  steps: string[];
  /** If NEEDS_INFO, the questions to answer */
  questions?: string[];
  /** If COMPLETED, the answer/result */
  answer?: string;
  /** If FAILED, the error message */
  error?: string;
}

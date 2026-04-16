/**
 * Canonical exit codes for the Hanzi Browse CLI.
 *
 * Agents and scripts rely on these to detect outcomes without parsing stdout.
 */
export const EXIT_OK = 0;         // Task completed successfully.
export const EXIT_TASK_ERROR = 1; // The task itself failed (sub-agent reported error).
export const EXIT_CLI_ERROR = 2;  // CLI-level error (bad args, connection failure, missing file).
export const EXIT_TIMEOUT = 3;    // Task exceeded --timeout (or the default 5 min).

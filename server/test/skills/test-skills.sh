#!/usr/bin/env bash
#
# Skill Testing Script for Hanzi Browse
#
# Runs a simple browser automation task for each skill via the CLI,
# captures the result, and reports pass/fail.
#
# Usage:
#   ./test-skills.sh                  # Run all skill tests
#   ./test-skills.sh hanzi-browse     # Run a single skill test
#   ./test-skills.sh --dry-run        # Print commands without executing
#   ./test-skills.sh --dry-run e2e    # Dry-run a single skill (partial match)
#
# Prerequisites:
#   - Chrome extension loaded and running
#   - Server built: cd server && npm run build
#   - For login-required skills: signed into the relevant platform

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve to server root: test/skills/../../ -> server/
SERVER_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="node $SERVER_ROOT/dist/cli.js"

# Timeout per task in seconds (5 minutes)
TASK_TIMEOUT=300
# Poll interval in seconds
POLL_INTERVAL=5

DRY_RUN=false
FILTER=""
PASSED=0
FAILED=0
SKIPPED=0
RESULTS=()

# --- Parse arguments ---

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [skill-name-filter]"
      echo ""
      echo "Options:"
      echo "  --dry-run    Print commands without executing"
      echo "  skill-name   Only run tests matching this name (partial match)"
      echo ""
      echo "Skills: hanzi-browse, e2e-tester, a11y-auditor, data-extractor,"
      echo "        social-poster, linkedin-prospector, x-marketer"
      exit 0
      ;;
    *) FILTER="$arg" ;;
  esac
done

# --- Color output ---

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()  { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_pass()  { echo -e "${GREEN}[PASS]${NC}  $1"; }
log_fail()  { echo -e "${RED}[FAIL]${NC}  $1"; }
log_skip()  { echo -e "${YELLOW}[SKIP]${NC}  $1"; }
log_dry()   { echo -e "${YELLOW}[DRY]${NC}   $1"; }

# --- Skill definitions ---
# Each skill: name, needs_login (true/false), task, url (or empty), extra_args

declare -a SKILLS=(
  "hanzi-browse"
  "e2e-tester"
  "a11y-auditor"
  "data-extractor"
  "social-poster"
  "linkedin-prospector"
  "x-marketer"
)

skill_task() {
  case "$1" in
    hanzi-browse)       echo "Read the page title and first paragraph of text" ;;
    e2e-tester)         echo "Verify the page loads, has a heading, and the More Information link is present" ;;
    a11y-auditor)       echo "Run an accessibility audit and list any issues found" ;;
    data-extractor)     echo "Extract all hyperlinks from this page as a JSON array with text and href fields" ;;
    social-poster)      echo "Draft a LinkedIn post about browser automation for QA teams" ;;
    linkedin-prospector) echo "Find 3 QA engineers in San Francisco. Do NOT send any connection requests" ;;
    x-marketer)         echo "Find 3 tweets about browser automation and suggest helpful replies. Do NOT post anything" ;;
  esac
}

skill_url() {
  case "$1" in
    hanzi-browse)        echo "https://example.com" ;;
    e2e-tester)          echo "https://example.com" ;;
    a11y-auditor)        echo "https://example.com" ;;
    data-extractor)      echo "https://example.com" ;;
    social-poster)       echo "" ;;
    linkedin-prospector) echo "https://www.linkedin.com" ;;
    x-marketer)          echo "" ;;
  esac
}

skill_context() {
  case "$1" in
    social-poster)       echo "Dry run only. Do NOT post anything. Just show me the draft." ;;
    x-marketer)          echo "Product: Hanzi Browse - browser automation for AI agents. URL: https://browse.hanzilla.co. Dry run only, do NOT post." ;;
    *)                   echo "" ;;
  esac
}

skill_needs_login() {
  case "$1" in
    social-poster|linkedin-prospector|x-marketer) echo "true" ;;
    *) echo "false" ;;
  esac
}

skill_expected_content() {
  case "$1" in
    hanzi-browse)        echo "Example Domain" ;;
    e2e-tester)          echo "heading" ;;
    a11y-auditor)        echo "accessibility\|WCAG\|contrast\|landmark\|audit" ;;
    data-extractor)      echo "href\|link\|iana" ;;
    social-poster)       echo "draft\|post\|LinkedIn" ;;
    linkedin-prospector) echo "engineer\|QA\|profile\|San Francisco" ;;
    x-marketer)          echo "tweet\|reply\|browser\|automation" ;;
  esac
}

# --- Build CLI command ---

build_command() {
  local skill="$1"
  local task
  task="$(skill_task "$skill")"
  local url
  url="$(skill_url "$skill")"
  local context
  context="$(skill_context "$skill")"

  local cmd="$CLI start \"$task\" --json"

  if [ -n "$url" ]; then
    cmd="$cmd --url \"$url\""
  fi

  # Use --skill for all skills except hanzi-browse (which is the base skill)
  if [ "$skill" != "hanzi-browse" ]; then
    cmd="$cmd --skill $skill"
  fi

  if [ -n "$context" ]; then
    cmd="$cmd --context \"$context\""
  fi

  echo "$cmd"
}

# --- Run a single skill test ---

run_skill_test() {
  local skill="$1"
  local cmd
  cmd="$(build_command "$skill")"
  local needs_login
  needs_login="$(skill_needs_login "$skill")"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  log_info "Testing skill: $skill"

  if [ "$DRY_RUN" = true ]; then
    log_dry "Would run: $cmd"
    log_dry "Needs login: $needs_login"
    log_dry "Expected content pattern: $(skill_expected_content "$skill")"
    SKIPPED=$((SKIPPED + 1))
    RESULTS+=("SKIP $skill (dry run)")
    return 0
  fi

  if [ "$needs_login" = "true" ]; then
    log_info "This skill requires platform login. Ensure you are signed in."
  fi

  log_info "Running: $cmd"

  # Run the CLI command with timeout, capture output
  local output
  local exit_code=0
  output=$(timeout "$TASK_TIMEOUT" bash -c "$cmd" 2>&1) || exit_code=$?

  if [ "$exit_code" -eq 124 ]; then
    log_fail "$skill - Timed out after ${TASK_TIMEOUT}s"
    FAILED=$((FAILED + 1))
    RESULTS+=("FAIL $skill (timeout)")
    return 1
  fi

  if [ "$exit_code" -ne 0 ]; then
    log_fail "$skill - CLI exited with code $exit_code"
    echo "  Output: ${output:0:200}"
    FAILED=$((FAILED + 1))
    RESULTS+=("FAIL $skill (exit code $exit_code)")
    return 1
  fi

  # Parse JSON output to check status
  local status
  status=$(echo "$output" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "unknown")

  if [ "$status" = "error" ]; then
    local error_msg
    error_msg=$(echo "$output" | grep -o '"error":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "unknown error")
    log_fail "$skill - Task errored: $error_msg"
    FAILED=$((FAILED + 1))
    RESULTS+=("FAIL $skill (error: $error_msg)")
    return 1
  fi

  if [ "$status" != "completed" ]; then
    log_fail "$skill - Unexpected status: $status"
    echo "  Output: ${output:0:200}"
    FAILED=$((FAILED + 1))
    RESULTS+=("FAIL $skill (status: $status)")
    return 1
  fi

  # Check if result contains expected content (case-insensitive)
  local expected
  expected="$(skill_expected_content "$skill")"
  if echo "$output" | grep -qi "$expected"; then
    log_pass "$skill - Completed with expected content"
    PASSED=$((PASSED + 1))
    RESULTS+=("PASS $skill")
  else
    log_fail "$skill - Completed but result missing expected content"
    echo "  Expected pattern: $expected"
    echo "  Output: ${output:0:300}"
    FAILED=$((FAILED + 1))
    RESULTS+=("FAIL $skill (missing expected content)")
    return 1
  fi

  return 0
}

# --- Main ---

echo ""
echo "====================================================="
echo "  Hanzi Browse - Skill Test Runner"
echo "====================================================="
echo ""

if [ "$DRY_RUN" = true ]; then
  log_info "DRY RUN mode - no commands will be executed"
fi

if [ -n "$FILTER" ]; then
  log_info "Filter: only skills matching '$FILTER'"
fi

# Check CLI exists (unless dry run)
if [ "$DRY_RUN" = false ]; then
  if [ ! -f "$SERVER_ROOT/dist/cli.js" ]; then
    echo ""
    log_fail "CLI not found at $SERVER_ROOT/dist/cli.js"
    echo "  Run: cd server && npm run build"
    exit 1
  fi
fi

# Run tests
for skill in "${SKILLS[@]}"; do
  # Apply filter (partial match)
  if [ -n "$FILTER" ] && [[ "$skill" != *"$FILTER"* ]]; then
    continue
  fi

  run_skill_test "$skill" || true
done

# --- Summary ---

echo ""
echo "====================================================="
echo "  Test Summary"
echo "====================================================="
echo ""

for result in "${RESULTS[@]}"; do
  case "$result" in
    PASS*) echo -e "  ${GREEN}$result${NC}" ;;
    FAIL*) echo -e "  ${RED}$result${NC}" ;;
    SKIP*) echo -e "  ${YELLOW}$result${NC}" ;;
  esac
done

echo ""
echo "  Passed:  $PASSED"
echo "  Failed:  $FAILED"
echo "  Skipped: $SKIPPED"
echo "  Total:   $((PASSED + FAILED + SKIPPED))"
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo -e "  ${RED}Some tests failed.${NC}"
  exit 1
elif [ "$DRY_RUN" = true ]; then
  echo -e "  ${YELLOW}Dry run complete. No tests were executed.${NC}"
  exit 0
else
  echo -e "  ${GREEN}All tests passed.${NC}"
  exit 0
fi

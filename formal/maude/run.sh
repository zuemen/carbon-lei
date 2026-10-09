#!/usr/bin/env bash
# Run the Maude checks, one Maude process per command, each under a memory watchdog.
#
#   formal/maude/run.sh [checks file] [filter]
#
# The checks file (default formal/maude/checks.maude) holds one line per command, "<expected> :
# <Maude command>", after a "select" line; <expected> is none (search finds no solution), found (it
# finds one), true (the LTL formula holds) or counterexample (it does not). Lines starting with "***"
# are comments and are echoed. Only lines containing [filter] (a fixed string, optional) are run.
# The script exits non-zero if any result differs from its expectation. Maude binary: $MAUDE, else
# `maude` on PATH.
#
# Watchdog: Maude is killed when its resident memory exceeds MAUDE_MAX_RSS_MB (default 3072), or,
# on macOS, when the system-wide free memory reported by `memory_pressure` is below
# MAUDE_MIN_FREE_PCT (default 15) while Maude holds more than MAUDE_FREE_CHECK_MIN_RSS_MB (default
# 256): on a machine that is already short of free memory a small run is not stopped, a growing
# one is. A killed command is reported as KILLED and makes the script exit non-zero.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
checks="${1:-$here/checks.maude}"
filter="${2:-}"
maude_bin="${MAUDE:-$(command -v maude || true)}"
if [[ -z "$maude_bin" || ! -x "$maude_bin" ]]; then
  echo "Maude not found: set MAUDE=/path/to/maude or put maude on PATH (Maude 3.5.1: https://github.com/maude-lang/Maude/releases/tag/Maude3.5.1)" >&2
  exit 2
fi
if pgrep -x maude >/dev/null 2>&1; then
  echo "another maude process is running; run one at a time" >&2
  exit 3
fi

max_rss_kb=$(( ${MAUDE_MAX_RSS_MB:-3072} * 1024 ))
min_free=${MAUDE_MIN_FREE_PCT:-15}
free_check_rss_kb=$(( ${MAUDE_FREE_CHECK_MIN_RSS_MB:-256} * 1024 ))
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "[run.sh] $("$maude_bin" --version 2>&1 | head -1 | sed 's/^/Maude /') at $maude_bin"
module=""
failed=0
n=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "${line// }" ]] && continue
  if [[ "$line" == "***"* ]]; then echo "$line"; continue; fi
  if [[ "$line" == select* ]]; then module="$line"; continue; fi
  if [[ -n "$filter" && "$line" != *"$filter"* ]]; then continue; fi
  expect="${line%% : *}"
  line="${line#* : }"
  n=$((n + 1))
  {
    echo "load $here/carbonlei.maude"
    echo "set show advisories off ."
    echo "$module"
    echo "$line"
    echo "quit"
  } > "$tmp/cmd.maude"
  start=$(date +%s)
  "$maude_bin" -no-banner -no-advise "$tmp/cmd.maude" < /dev/null > "$tmp/out.txt" 2>&1 &
  pid=$!
  peak=0
  killed=""
  while kill -0 "$pid" 2>/dev/null; do
    rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
    rss=${rss:-0}
    (( rss > peak )) && peak=$rss
    if (( rss > max_rss_kb )); then
      killed="resident memory ${rss} KB > limit ${max_rss_kb} KB"
    elif (( rss > free_check_rss_kb )) && command -v memory_pressure >/dev/null 2>&1; then
      free=$(memory_pressure 2>/dev/null | sed -n 's/.*free percentage: \([0-9]*\)%.*/\1/p')
      if [[ -n "$free" ]] && (( free < min_free )); then
        killed="system free memory ${free}% < ${min_free}% with Maude at ${rss} KB"
      fi
    fi
    if [[ -n "$killed" ]]; then
      kill -9 "$pid" 2>/dev/null
      break
    fi
    sleep 0.5
  done
  wait "$pid" 2>/dev/null
  secs=$(( $(date +%s) - start ))
  grep -v '^Bye\.$' "$tmp/out.txt"
  if [[ -n "$killed" ]]; then
    echo "KILLED by the watchdog after ${secs} s: $killed"
    failed=1
    continue
  fi
  case "$expect" in
    none) pattern='^No solution\.' ;;
    found) pattern='^Solution 1 ' ;;
    true) pattern='^result Bool: true' ;;
    counterexample) pattern='^result ModelCheckResult: counterexample' ;;
    *) pattern='^$NEVER' ;;
  esac
  if grep -q "$pattern" "$tmp/out.txt"; then verdict="as expected ($expect)"; else verdict="UNEXPECTED (expected $expect)"; failed=1; fi
  echo "[run.sh] $verdict; wall ${secs} s, peak resident memory ${peak} KB (sampled every 0.5 s)"
done < "$checks"
if (( failed )); then echo "[run.sh] $n command(s) run: FAILED"; else echo "[run.sh] $n command(s) run, every result as expected"; fi
exit $failed

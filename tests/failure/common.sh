#!/bin/sh
# Shared helpers for the failure-injection scripts in this directory.
# Every script here assumes `docker compose up` is already running the
# full stack, and restores whatever it stopped before exiting.

BASE_URL="${BASE_URL:-http://localhost:8080/api}"
ROOT_URL="${ROOT_URL:-http://localhost:8080}"

pass() { printf '\033[32m[PASS]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[FAIL]\033[0m %s\n' "$1"; FAILED=1; }
info() { printf '\033[36m[INFO]\033[0m %s\n' "$1"; }

expect_status() {
  description="$1"
  expected="$2"
  actual="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$description (got $actual)"
  else
    fail "$description (expected $expected, got $actual)"
  fi
}

http_status() {
  curl -s -o /dev/null -w '%{http_code}' "$@"
}

FAILED=0

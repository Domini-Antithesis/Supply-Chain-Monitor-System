#!/usr/bin/env bash
# Supply Chain Monitor - one-command launcher (macOS / Linux / Git Bash).
#
#   ./start.sh
#
# On a fresh install this starts the dashboard, opens the setup page in your
# browser, waits for you to save your keys, then brings the rest of the stack
# up automatically. On an already-configured install it just starts everything.
#
# Kept pure ASCII to match start.ps1, so the pair survives any encoding round
# trip (zipping, copying between machines, non-UTF-8 locales) intact.

set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m    %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    %s\033[0m\n' "$1"; }
err()  { printf '\033[31m%s\033[0m\n' "$1"; }

open_url() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 || true
  elif command -v start >/dev/null 2>&1; then start "$1" >/dev/null 2>&1 || true
  else echo "    Open this in your browser: $1"; fi
}

docker_ready() { docker info >/dev/null 2>&1; }

step "Checking Docker"
if ! docker_ready; then
  warn "Docker is not responding yet. It may be starting up, or asleep in"
  warn "Resource Saver mode. Waiting up to 90 seconds for it to wake..."

  ready=0
  for _ in $(seq 1 30); do
    sleep 3
    if docker_ready; then ready=1; break; fi
  done

  if [ "$ready" -eq 0 ]; then
    echo ""
    err "Could not reach the Docker engine."
    echo ""
    echo "Open Docker Desktop and wait for the whale icon to stop animating, then"
    echo "run this again. Note that 'docker compose version' can succeed even when"
    echo "the engine is down - it is a client-side command and never contacts it."
    echo ""
    # Filtered rather than dumped: `docker info` prints its whole client section
    # even when the server is unreachable, which buries the actual reason.
    echo "Docker reported:"
    docker info 2>&1 | grep -Ei "error|refused|denied|cannot|permission" | head -3 | sed 's/^/    /' || true
    exit 1
  fi
fi
ok "Docker is running."

FRESH_INSTALL=0
if [ ! -f .env ]; then
  FRESH_INSTALL=1

  step "First run - starting the setup page"
  docker compose up -d dashboard >/dev/null

  for _ in $(seq 1 40); do
    if curl -fs http://localhost:8080/api/setup/status >/dev/null 2>&1; then break; fi
    sleep 1
  done

  ok "Opening http://localhost:8080/setup"
  open_url "http://localhost:8080/setup"
  echo ""
  echo "    Fill in the form in your browser. Each service is linked with instructions."
  echo "    This terminal is waiting and will finish setup automatically once you save."
  echo ""

  step "Waiting for you to save your configuration"
  waited=0
  while [ ! -f .env ]; do
    sleep 2
    waited=$((waited + 2))
    if [ $((waited % 60)) -eq 0 ]; then warn "still waiting... ($((waited / 60)) min)"; fi
    if [ "$waited" -ge 3600 ]; then
      err "Timed out after an hour. Re-run ./start.sh when you are ready."
      exit 1
    fi
  done
  ok "Configuration saved."
fi

step "Starting all services"
docker compose up -d

step "Running first-boot setup (account, Airtable tables, workflows)"
docker wait supply-chain-monitor-bootstrap >/dev/null 2>&1 || true
docker logs supply-chain-monitor-bootstrap 2>&1 | sed 's/^/    /' || true

echo ""
ok "Ready."
echo ""
echo "    Dashboard : http://localhost:8080"
echo "    n8n       : http://localhost:5678"
echo ""
echo "    Stop everything with:  docker compose down"
echo ""

if [ "$FRESH_INSTALL" -eq 1 ]; then open_url "http://localhost:8080"; fi

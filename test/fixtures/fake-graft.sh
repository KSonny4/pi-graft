#!/bin/sh
# Stand-in for the graft CLI: logs every call, answers the few the
# extension makes, and never touches a real graph.
printf '%s\n' "$*" >> "${GRAFT_LOG:?}"
case "$1" in
  --version) echo "graft 0.0.0-test" ;;
  check) echo '{"graph":{"changed":["src/a.ts"],"added":[],"removed":[]}}' ;;
  build) exit 0 ;;
  *) echo '{}' ;;
esac

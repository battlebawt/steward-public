#!/bin/sh
set -eu

if [ -n "${RAILWAY_VOLUME_MOUNT_PATH:-}" ]; then
  if [ "$RAILWAY_VOLUME_MOUNT_PATH" != /app/data ] || [ "$(id -u)" != 0 ]; then
    echo 'Invalid staging volume mount or startup user' >&2
    exit 1
  fi
  chown bun:bun /app/data
  exec setpriv --reuid=1000 --regid=1000 --init-groups "$@"
fi

if [ "$(id -u)" = 0 ]; then
  echo 'Root startup without the reviewed staging volume is disabled' >&2
  exit 1
fi

exec "$@"

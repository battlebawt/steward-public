#!/bin/sh
set -eu
# The updater and scanner share this persistent, service-owned directory.
exec /usr/bin/clamscan --database=/app/data/clamav "$@"

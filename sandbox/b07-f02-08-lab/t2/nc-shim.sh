#!/bin/bash
# B07: nc mínimo para o compute.sh oficial, que só usa `nc -z <host> <porta>` (porta TCP aberta?).
[ "$1" = -z ] || { echo "b07 nc-shim: só -z é suportado" >&2; exit 2; }
timeout 3 bash -c "exec 3<>/dev/tcp/$2/$3" 2>/dev/null

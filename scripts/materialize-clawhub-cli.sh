#!/usr/bin/env bash

set -euo pipefail

source_root="${1:?trusted ClawHub CLI source root is required}"
destination="${2:?ClawHub CLI destination is required}"
github_output="${3:-}"
cli_label=ClawHub
cli_package=clawhub
expected_version=0.23.3
expected_lock_sha256="5f7da1abdfcaf8adcf8a20b609f677cd7a0e9ffe37e078b39d0b742bce5ce6af"
expected_integrity="sha512-VwM6FQrZVarFRDiEqG42npUeyCu/iLhPnpO+b7kKIGRXv+TA6Lb8pboHnIgT6cmjFEnW3j/pTbshWeDQMQ7QWQ=="
additional_bin=""
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/materialize-pinned-cli.sh"

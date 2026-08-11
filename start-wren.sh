#!/usr/bin/env bash
set -euo pipefail

launch_dir=$PWD
repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
env_file_input=${WREN_ENV_FILE:-"${HOME}/.config/wren/.env"}
bun_version=${BUN_VERSION:-1.3.14}

if [[ "${env_file_input}" = /* ]]; then
  env_file=${env_file_input}
else
  env_file="${launch_dir}/${env_file_input}"
fi

env_args=()
if [[ -f "${env_file}" ]]; then
  env_args=("--env-file=${env_file}")
fi

exec npm exec --yes --package="bun@${bun_version}" -- bun "${env_args[@]}" "${repo_root}/apps/cli/src/main.ts" "$@"

#!/usr/bin/env sh
set -eu

workspace_folder="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
workspace_folder="$(cd "$workspace_folder" && pwd)"
workspace_basename="$(basename "$workspace_folder")"
expected_compose_dir="$workspace_folder/.devcontainer"

for project_name in "devcontainer" "${workspace_basename}_devcontainer"; do
  container_ids="$(docker ps -aq --filter "label=com.docker.compose.project=${project_name}" 2>/dev/null || true)"
  for container_id in $container_ids; do
    working_dir="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$container_id" 2>/dev/null || true)"
    if [ "$working_dir" = "$expected_compose_dir" ]; then
      docker rm -f "$container_id" >/dev/null 2>&1 || true
    fi
  done

  network_ids="$(docker network ls -q --filter "label=com.docker.compose.project=${project_name}" 2>/dev/null || true)"
  for network_id in $network_ids; do
    working_dir="$(docker network inspect --format '{{ index .Labels "com.docker.compose.project.working_dir" }}' "$network_id" 2>/dev/null || true)"
    if [ "$working_dir" = "$expected_compose_dir" ]; then
      docker network rm "$network_id" >/dev/null 2>&1 || true
    fi
  done
done

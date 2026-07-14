param(
  [string]$WorkspaceFolder
)

if (-not $WorkspaceFolder) {
  $WorkspaceFolder = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

$WorkspaceFolder = [IO.Path]::GetFullPath($WorkspaceFolder)
$expectedComposeDir = [IO.Path]::GetFullPath((Join-Path $WorkspaceFolder '.devcontainer')).TrimEnd('\', '/').Replace('\', '/').ToLowerInvariant()

$projectNames = @(
  'devcontainer',
  "$(Split-Path -Leaf $WorkspaceFolder)_devcontainer"
) | Select-Object -Unique

foreach ($projectName in $projectNames) {
  $containerIds = @(docker ps -aq --filter "label=com.docker.compose.project=$projectName" 2>$null)
  foreach ($containerId in $containerIds) {
    if (-not $containerId) { continue }
    $workingDir = docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' $containerId 2>$null
    $normalizedWorkingDir = "$workingDir".Trim().TrimEnd('\', '/').Replace('\', '/').ToLowerInvariant()
    if ($normalizedWorkingDir -eq $expectedComposeDir) {
      docker rm -f $containerId *> $null
    }
  }

  $networkIds = @(docker network ls -q --filter "label=com.docker.compose.project=$projectName" 2>$null)
  foreach ($networkId in $networkIds) {
    if (-not $networkId) { continue }
    $workingDir = docker network inspect --format '{{ index .Labels "com.docker.compose.project.working_dir" }}' $networkId 2>$null
    $normalizedWorkingDir = "$workingDir".Trim().TrimEnd('\', '/').Replace('\', '/').ToLowerInvariant()
    if ($normalizedWorkingDir -eq $expectedComposeDir) {
      docker network rm $networkId *> $null
    }
  }
}

exit 0

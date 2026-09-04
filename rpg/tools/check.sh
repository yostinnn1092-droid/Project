#!/usr/bin/env bash
# Compile the RPG scripts against real UnityEngine assemblies, without Unity.
#
#   ./rpg/tools/check.sh
#
# Why this exists: the scripts in this project are written in an environment
# with no Unity and no editor, so the alternative is handing over C# that has
# never met a compiler. This catches everything a compiler catches — typos,
# wrong argument counts, misremembered Unity API signatures, missing usings —
# which is the bulk of what goes wrong when code is written blind.
#
# What it does NOT catch, and must not be mistaken for:
#   * anything about the RUNTIME — null references, wiring, execution order
#   * anything about whether the game is any good to play
#   * API differences between the reference assemblies below and your Unity
#     version. These are 2021.3 assemblies because that is the only version
#     Unity publishes to NuGet; the APIs used here are long-stable, but a green
#     build is not a promise about Unity 6 specifically.
#
# First run downloads the SDK and the assemblies (a few hundred MB) and takes a
# while. After that it is a couple of seconds.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(dirname "$HERE")/Assets/Scripts"
DOTNET_DIR="${DOTNET_ROOT:-/opt/dotnet}"
WORK="${RPG_CHECK_DIR:-/tmp/rpg-check}"
UNITY_VER="2021.3.33"
PKG="$HOME/.nuget/packages/unityengine.modules/$UNITY_VER/lib/net45"

export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

if [ ! -x "$DOTNET_DIR/dotnet" ]; then
  echo "==> installing the .NET SDK into $DOTNET_DIR"
  curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
  bash /tmp/dotnet-install.sh --channel 8.0 --install-dir "$DOTNET_DIR" --no-path
fi
export DOTNET_ROOT="$DOTNET_DIR"
export PATH="$DOTNET_DIR:$PATH"

if [ ! -d "$WORK" ]; then
  echo "==> setting up the check project in $WORK"
  mkdir -p "$WORK"
  ( cd "$WORK" && dotnet new classlib -o Check --framework netstandard2.1 >/dev/null )
  rm -f "$WORK/Check/Class1.cs"
  # Pulls the assemblies into the NuGet cache; they are then referenced by path
  # below, because they ship as net45 libs and a netstandard project will not
  # pick them up on its own.
  ( cd "$WORK/Check" && dotnet add package UnityEngine.Modules --version "$UNITY_VER" >/dev/null )
fi

cat > "$WORK/Check/Check.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.1</TargetFramework>
    <LangVersion>9.0</LangVersion>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <!-- Fields assigned only by the Unity inspector look unused to the compiler. -->
    <NoWarn>CS0649;CS0414</NoWarn>
    <AssemblyName>RpgCheck</AssemblyName>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="$SCRIPTS/**/*.cs" />
  </ItemGroup>
  <ItemGroup>
    <Reference Include="UnityEngine"><HintPath>$PKG/UnityEngine.dll</HintPath></Reference>
    <Reference Include="UnityEngine.CoreModule"><HintPath>$PKG/UnityEngine.CoreModule.dll</HintPath></Reference>
    <Reference Include="UnityEngine.PhysicsModule"><HintPath>$PKG/UnityEngine.PhysicsModule.dll</HintPath></Reference>
    <Reference Include="UnityEngine.AnimationModule"><HintPath>$PKG/UnityEngine.AnimationModule.dll</HintPath></Reference>
    <Reference Include="UnityEngine.InputLegacyModule"><HintPath>$PKG/UnityEngine.InputLegacyModule.dll</HintPath></Reference>
    <Reference Include="UnityEngine.AIModule"><HintPath>$PKG/UnityEngine.AIModule.dll</HintPath></Reference>
    <Reference Include="UnityEngine.UI"><HintPath>$PKG/UnityEngine.UI.dll</HintPath></Reference>
  </ItemGroup>
</Project>
EOF

cd "$WORK/Check"
dotnet build -v q --nologo 2>&1 | grep -E "error CS|Build succeeded|Warning\(s\)|Error\(s\)" || true

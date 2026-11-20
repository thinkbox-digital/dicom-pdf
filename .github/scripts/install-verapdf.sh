#!/usr/bin/env bash
set -euo pipefail

base=$(mkdir -p target/ci-verapdf && cd target/ci-verapdf && pwd)
version=1.30.4
installer="$base/installer.zip"
if [[ ! -f "$installer" ]]; then
    curl --fail --silent --show-error --location --retry 3 \
        "https://software.verapdf.org/releases/1.30/verapdf-greenfield-$version-installer.zip" \
        --output "$installer"
fi
printf '%s  %s\n' '04415ef3f149526a3048b9889723e81320ddf013bd891bcc7f0f297f3eadcc23' "$installer" | sha256sum --check
unzip -oq "$installer" -d "$base"
cat > "$base/install.xml" <<EOF
<AutomatedInstallation langpack="eng">
  <com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/>
  <com.izforge.izpack.panels.target.TargetPanel id="install_dir">
    <installpath>$base/installed</installpath>
  </com.izforge.izpack.panels.target.TargetPanel>
  <com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select">
    <pack index="0" name="veraPDF GUI" selected="false"/>
    <pack index="1" name="veraPDF CLI" selected="true"/>
    <pack index="2" name="veraPDF Documentation" selected="false"/>
    <pack index="3" name="veraPDF Sample Plugins" selected="false"/>
  </com.izforge.izpack.panels.packs.PacksPanel>
  <com.izforge.izpack.panels.install.InstallPanel id="install"/>
  <com.izforge.izpack.panels.finish.FinishPanel id="finish"/>
</AutomatedInstallation>
EOF
java -jar "$base/verapdf-greenfield-$version/verapdf-izpack-installer-$version.jar" "$base/install.xml"
"$base/installed/verapdf" --version
if [[ -n ${GITHUB_ENV:-} ]]; then
    printf 'VERAPDF=%s\n' "$base/installed/verapdf" >> "$GITHUB_ENV"
fi

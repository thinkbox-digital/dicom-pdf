#!/usr/bin/env bash
set -euo pipefail

branch_ref=${GITHUB_REF:?}
run_id=${GITHUB_RUN_ID:?}
if [[ $branch_ref != refs/heads/* || ! $run_id =~ ^[0-9]+$ ]]; then
    echo "Expected a branch ref and a numeric GitHub Actions run ID." >&2
    exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Versioning requires a clean tracked checkout." >&2
    exit 1
fi

fetch_tip() {
    git fetch --no-tags origin "$branch_ref" >&2 && git rev-parse FETCH_HEAD
}

marker="GitHub-Actions-Version-Run: $run_id"
tip=$(fetch_tip)
for attempt in 1 2 3; do
    existing_commit=$(git log -1 --format=%H --grep="^$marker$" "$tip")
    if [[ -n $existing_commit ]]; then
        echo "Version bump already committed for this push as $existing_commit."
        exit 0
    fi

    git switch --detach "$tip"
    application_version=$(python3 scripts/bump_application_version.py)
    application_version=${application_version##* }
    bash .github/scripts/check-viewer.sh
    viewer_version=$(node -p "require('./viewer/package.json').version")
    xvfb-run --auto-servernum --server-args="-screen 0 1600x1000x24" mvn --batch-mode --no-transfer-progress "-Ddicompdf.test.verapdf=${VERAPDF:?}" verify
    python3 scripts/check_desktop_distribution.py --version "$application_version" --verapdf "$VERAPDF"

    release="target/releases/$application_version"
    mkdir -p "$release"
    cp "dist/dicom-pdf-$application_version.jar" "dist/dicom-pdf-$application_version-desktop.jar" \
        "dist/dicom-pdf-$application_version-viewer.jar" \
        "target/dicom-pdf-chrome-$viewer_version.zip" src/main/resources/viewer.html "$release/"
    (cd "$release" && sha256sum -- *.jar *.zip viewer.html > SHA256SUMS)

    git add -u
    git add docs/desktop-viewer.png
    git -c user.name='github-actions[bot]' \
        -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
        commit -m 'Bump application and viewer minor versions' -m "$marker"
    if git push origin "HEAD:$branch_ref"; then
        printf 'version=%s\n' "$application_version" >> "${GITHUB_OUTPUT:?}"
        exit 0
    fi

    latest_tip=$(fetch_tip)
    if git merge-base --is-ancestor HEAD "$latest_tip"; then
        printf 'version=%s\n' "$application_version" >> "${GITHUB_OUTPUT:?}"
        exit 0
    fi
    if [[ $latest_tip == "$tip" ]]; then
        echo "Version commit push failed while $branch_ref was unchanged." >&2
        exit 1
    fi
    echo "$branch_ref advanced during attempt $attempt. Found $latest_tip."
    mv -- "dist/dicom-pdf-$application_version.jar" "dist/dicom-pdf-$application_version-desktop.jar" \
        "dist/dicom-pdf-$application_version-viewer.jar" "$release/"
    tip=$latest_tip
done

echo "Version commit could not be pushed after three attempts." >&2
exit 1

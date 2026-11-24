# Check library support before implementing changes

Before implementing any requested feature, bug fix, or other behavior change,
check whether the relevant libraries already provide the needed capability or
fix. Check the versions used by the project and consult upstream documentation
and release notes when needed. Prefer a supported library solution when it
meets the project's requirements. Write custom code for any remaining gaps.

# Generated outputs

Reserve the repository's `out/` directory exclusively for converted PDF files.
Put reports, screenshots, extracted/recovered files, staged inputs, and other
non-PDF generated artifacts under `target/`, alongside Maven build artifacts.
Preserve supplied inputs in `in/` and checked-in synthetic inputs in `fixtures/`.

Put the versioned, self-contained creator, viewer and command-line JARs in
`dist/`. Keep build intermediates and verification reports in `target/`.
Keep only the current version of each runnable JAR in `dist/`. Remove
superseded JARs from that directory after verifying the new distribution.
After each code update, rebuild and verify all three runnable JARs before
handing off the change. Use `out/greg.pdf` for both README desktop screenshots.
When the local archive is absent, keep the existing screenshots.

Every future rebuild of the runnable JARs must advance the application's minor
version, resetting patch to zero (for example, `0.4.0` becomes `0.5.0`). The
creator, viewer and command-line JARs produced together share one version and one bump.
Synchronize the application POM, JAR filenames, launchers, scripts, tests and
documented commands that refer to the distribution version. Do not change the
archival profile/schema versions just because the application is rebuilt.

Every browser viewer rebuild must advance its minor version, resetting patch to zero.
Build the standalone viewer and Chrome extension together from the shared viewer
source. `npm --prefix viewer run build` and its `build:extension` alias advance
both artifacts by one minor version and synchronize the package, lockfile,
extension manifest and documented ZIP names.

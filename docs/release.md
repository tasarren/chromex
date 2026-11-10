# Release

How a Chromex version reaches npm and GitHub Releases. No version has been released yet. Every step
that writes to GitHub or npm is an owner operation; the workflows never create tags, versions, or
changelog dates.

## Pieces

| Piece | Role |
| --- | --- |
| `.github/workflows/ci.yml` | One Docker run, `verify (node24)`, is the only job that can export a candidate. Called with `export-candidate: true`, the primary uploads artifact `candidate` and exposes `candidate-sha256`. Pull request and `main` runs export nothing. |
| `.github/workflows/release.yml` | Jobs `preflight`, `ci`, `stage`, `attach`. The only build of the package is inside `ci`; `attach` also packs the store zip from that verified tarball. |
| `packages/extension/scripts/package.ts` | Writes the store zip `chromex-<version>-chromium.zip` and `SHA256SUMS.txt` from an extension folder, with the manifest `key` removed. |
| `packages/plugin/scripts/verify-release.mjs` | Read-only guards: `preflight` checks the event, commit and manifests; `candidate <dir>` checks the downloaded artifact. |

The `candidate` artifact holds exactly four regular files: `tasarren-chromex-<version>.tgz`,
`SHA256SUMS`, `inventory.txt` (`tar -tvzf` listing) and `identity.txt` (source SHA, run ID, run
attempt, workflow ref). It is kept for seven days.

## Events

| Event | Allowed jobs | Permissions | Stops when |
| --- | --- | --- | --- |
| Dispatch `mode=verify` on `main` | `preflight`, `ci` (export) | `contents: read` | Ref is not `main`; commit is not the fetched `origin/main`; checkout is dirty; versions disagree or are not stable; package name or repository URL differs |
| Dispatch `mode=rehearse-stage` on `main` | Above plus `stage` | `stage`: `id-token: write`, `contents: read`, environment `npm-release` | As above, plus no dated changelog section for the version |
| Stable GitHub Release published | `preflight`, `ci`, `stage`, `attach` | `attach`: `contents: write` only | Prerelease; tag is not `v<version>`; tag is not the event commit; commit is not on `main`; no dated changelog section |
| Prerelease release, tag push, anything else | None | None | Not triggered or skipped |

The workflow sets `permissions: {}` and each job asks only for what it needs; `id-token: write`
appears only in `stage` and `contents: write` only in `attach`. Concurrency never cancels a running
release. `stage` and `attach` download `candidate` from their own run only, then require: the four
files, the tarball SHA-256 equal to the producer output (not to the copy inside the artifact), the
tarball name and the versions in its `package.json`, `plugin.json` and
extension `manifest.json` equal to the preflight version, and `identity.txt` naming the same commit
and run, and `inventory.txt` equal to `tar -tvzf` of the tarball (both sides use `LC_ALL=C TZ=UTC`).
`identity.txt` keeps the producer `run_attempt` but the guard does not compare it, so re-running a
failed job in the same run still passes. `attach` runs only after `stage` succeeds. It also attaches the store
zip `chromex-<version>-chromium.zip` and its `SHA256SUMS.txt`, built from the verified tarball's
extension folder. It lists the
release assets first: a name that already exists must hold the same bytes as the candidate (`cmp`),
and only missing names are uploaded. It never deletes or replaces an asset (`--clobber`).

A verify dispatch accepts the `## Unreleased` changelog. Staging and releases need a dated section,
`## [X.Y.Z] - YYYY-MM-DD`, added in a reviewed pull request.

Lint the workflows locally:

```bash
docker run --rm --network none -v "$PWD:/repo:ro" -w /repo \
  rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667
```

## Before the first release

These are owner operations on GitHub and npm. Record results without tokens, one-time codes, or
auth output.

1. **Repository settings.** Apply the `main` ruleset (pull request, resolved conversations, required
   `check` after its first green run, linear history, no force push or deletion), the two `v*` tag
   rulesets (creation limited to the release actor; update and deletion blocked for everyone),
   private vulnerability reporting, vulnerability alerts and Dependabot security updates. Keep the
   read-only default Actions token. Read each setting back through the API.
2. **Environment.** Create `npm-release` with deployment refs `main` and tags `v*`. Add no
   reviewers or wait timer: npm stage approval is the human gate.
3. **Package bootstrap.** `npm trust` needs an existing package, so the first stage uses the
   maintainer's own npm login, and npm then publishes a public `0.0.0-stage` placeholder. Produce the
   bytes with a `mode=verify` dispatch at the merged `main` commit, download `candidate`, check
   `sha256sum -c SHA256SUMS`, and stage that exact tarball. Do not rebuild locally.
4. **Trust (selected path).** Reject the bootstrap stage and confirm that the package remains and the
   version can be staged again. Then add stage-only trust for owner `tasarren`, repository
   `chromex`, workflow `release.yml`, environment `npm-release`, and set the package to require
   two-factor authentication and disallow tokens. Run one `mode=rehearse-stage` dispatch the same day
   and reject that stage too. This proves the trust tuple; it is a real registry write.
5. **If step 4 fails** (the version is not free after rejection, or trust cannot be saved): stop.
   The owner chooses between holding publication and publishing the version from the interactive stage
   without OIDC provenance. The workflow has no fallback that reuses another run's artifact.

## Release

1. Merge a release pull request that dates the changelog section and keeps all seven manifests at the
   same version; wait for green `check` on `main`.
2. Create annotated tag `v<version>` on that commit and publish a stable GitHub Release whose notes
   say `npm pending`. A tag push alone starts nothing. Preflight checks the commit the tag points to,
   not whether the tag is annotated; annotation is the operator's step.
3. `release.yml` stages the verified tarball. A green run means *awaiting approval*, not published.
4. Inspect the stage (package, version, `latest` tag, integrity, source commit and run), then approve
   it on npm with two-factor authentication.
5. Download the published tarball in a scratch directory with
   `npm pack @tasarren/chromex@<version>` and check its SHA-256 against the attached `SHA256SUMS`.
   The registry `dist.integrity` is a separate SHA-512 SRI value, not this SHA-256. That the
   registry returns the staged bytes unchanged is not proven yet: on a mismatch, stop and investigate. Then install the published
   version into a fresh HOME, run `chromex setup`, and remove `npm pending` from the notes.

## Chrome Web Store

There is no Chrome Web Store item for now: Observe users load the extension unpacked (see
[Installation](installation.md#install-the-observe-extension)). Each release still attaches a store
zip, `chromex-<version>-chromium.zip`, with `SHA256SUMS.txt`, built from the verified tarball. It is
the bundled extension with the manifest `key` removed, because the store rejects a `key` and gives
its item its own ID. The bundled copy keeps the `key` for Managed mode. A store listing may come later;
creating it, the OAuth setup and any upload would be new, owner-run steps, and setup would then add
the store ID (`STORE_EXTENSION_ID` in `packages/protocol/src/rpc.ts`) to the native-host file.

## Recovery

| Failure | Action |
| --- | --- |
| Preflight or CI fails | Nothing was staged. Fix the source in a reviewed commit; do not override a guard. |
| Stage rejected by npm (OIDC) | Check the trust tuple, environment, runner and trust age. No token fallback. |
| Stage timed out | Inspect npm stage state before retrying; never stage a second candidate for one version. |
| Wrong stage | Reject it on npm. A new stage needs a fresh `ci` artifact. **Re-run all jobs** repeats the `candidate` upload; an artifact name conflict is likely and fails closed (unproven). If a fresh run for the same tag cannot safely resume, stop and record the state for an owner decision. No destructive default. |
| `stage` failed | Inspect npm stage and registry state first. If a correct stage exists, resume approval; do not stage again. Only after confirming no correct stage exists, **Re-run failed jobs** in the same run (same-run artifact and producer output; `GITHUB_RUN_ID` unchanged, `run_attempt` not compared). |
| `attach` failed | **Re-run failed jobs** in the same run. It reuses the same-run artifact and producer output. |
| `attach` partly uploaded | Re-run the failed `attach` job: it checks existing assets against the candidate bytes and uploads only missing names. A mismatched existing asset fails the job; inspect it with `gh release view <tag> --json assets` before any manual change. Never `--clobber`. |
| Published version is defective | Release a new patch version; deprecate if needed. Never move or reuse a tag. |
| Secret found | Stop, revoke the credential, review history and artifacts. |

## Not proven yet

No workflow in this repository has run on GitHub. Pending remote cases: the store zip attached by
`attach`, the first pull request and
`main` runs of `check`, the artifact handoff between `ci` and `stage`, the `npx npm@11.21.0 stage
publish ./<tarball> --access public --tag latest` argument form, the OIDC trust tuple, bootstrap
rejection semantics, re-running failed jobs with the same artifact and outputs, "Re-run all jobs"
artifact name behavior, partial-asset resume, release asset upload, registry bytes equal to staged
bytes, and a public registry install.

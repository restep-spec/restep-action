# restep-action

Composite GitHub Action that checks a Restep 1 API on every pull request:

1. Starts the API (`start-command`) and waits until it responds (`wait-for`), or uses one that is
   already running (`url`).
2. Runs [restep-check](https://www.npmjs.com/package/restep-check) with `--json`
   (and `--writes` if asked) and checks that the API announces the profiles in `profiles`.
3. If given the base branch's discovery (`base-discovery`), compares it with the current one
   using `restep-diff` and flags breaking changes (§5.5).
4. Writes the result to the job summary (`$GITHUB_STEP_SUMMARY`), with the version the API
   declares in `restep` (§1.1: a `1.0-draft.6` or a `1.0-rc.1` shows up as a draft or candidate,
   without the guarantees of a published version, and a major version other than 1, or one that
   does not follow the grammar, as "not Restep 1"), with one annotation per
   failing MUST, and, with `comment: true`, as a PR comment, always the same one
   (one per API URL), updated on every run.
5. Stops the API, even if something failed.

The steps are `node action.mjs <step>` (Node 18+, no dependencies; GitHub runners ship
Node). Inputs reach the scripts as environment variables, never interpolated into shell
code.

## Example

```yaml
# .github/workflows/restep.yml
name: Restep
on: pull_request

permissions:
  contents: read
  pull-requests: write   # only for comment: true

jobs:
  restep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci

      # The base branch's discovery, if the repository keeps it in a file.
      - name: Base discovery
        run: git show "origin/${{ github.base_ref }}:api/discovery.json" > "$RUNNER_TEMP/base.json"

      - uses: restep-spec/restep-action@v0   # or the path to this folder: ./tools/restep-action
        with:
          url: http://localhost:3000/
          start-command: npm start
          wait-for: http://localhost:3000/health
          profiles: core,query,writes
          writes: true
          base-discovery: ${{ runner.temp }}/base.json
          comment: true
          headers: |
            Authorization: Bearer ${{ secrets.RESTEP_TEST_TOKEN }}
```

If the base branch is deployed (for example in a staging environment), `base-discovery` also
accepts a URL: the action fetches its discovery. The `headers` are only sent to that URL if it
has the same origin as `url` (§4.3). If the root is not a discovery and points to one with
`Link: rel="service-desc"`, the action follows the first target that is one, but not one whose
scheme is neither `https` nor the root's (`data:`, `file:`, §3), and it does not send the headers
to one on another origin.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `url` | (required) | API root |
| `start-command` | | Command that starts the API in the background (in `GITHUB_WORKSPACE`); its output goes to `$RUNNER_TEMP/restep-action/server.log` and is shown if it fails to start |
| `wait-for` | `url` | URL that must respond (with any HTTP status) before going on |
| `wait-timeout` | `60` | Maximum wait, in seconds |
| `profiles` | | Profiles and extensions the API must announce, separated by commas or spaces |
| `writes` | `false` | `true` passes `--writes` to restep-check (creates, changes and deletes its own items) |
| `headers` | | Headers for every request, one per line. `Authorization` is kept out of the log |
| `base-discovery` | | Base branch's discovery: a file (relative to `GITHUB_WORKSPACE`) or a URL |
| `comment` | `false` | `true` comments on the PR (needs `pull-requests: write`). Outside a PR it only writes the summary |
| `fail-on-error` | `true` | Fails the job if a MUST fails, a profile is missing, there is a breaking change or something could not be checked |
| `restep-check` | `npx --yes restep-check@0.9` | Command that runs restep-check (0.9 checks draft 6) |
| `restep-diff` | `npx --yes restep-diff@0.2` | Command that runs restep-diff (0.2 classifies according to draft 6) |
| `github-token` | `github.token` | Token for `gh` |

## Outputs

| Output | Value |
|---|---|
| `result` | `pass` or `fail` |
| `check-failures` | Number of failing MUST checks |
| `breaking` | `true` if restep-diff finds breaking changes |
| `summary-file` | Path to the Markdown report (the same as the summary and the comment) |

## Dependency on restep-diff

`restep-diff` is another Restep tool ([restep-spec/restep-diff](https://github.com/restep-spec/restep-diff)).
The action assumes this interface:

```
restep-diff <old.json> <new.json> --markdown --fail-on breaking
```

- Standard output: the Markdown report, which the action includes as is.
- Exit code: `0` with no breaking changes, `1` with some, anything else if it could not
  compare (the action treats that as an error and shows its error output).

It is not on npm: the default command installs it from its repository at a fixed version. If its
interface changes, `diff()` in `action.mjs` and the test double in `test.mjs` have to change.

## Tests

```bash
node tools/restep-action/test.mjs
```

No dependencies, no network. Validates `action.yml` with a parser for the YAML subset it uses
(and cross-checks it against Ruby's if installed), reviews its structure (inputs declared and
used, outputs pointing to steps that exist, no `${{ }}` inside a `run`) and runs the steps
locally simulating the runner: the `GITHUB_*` and `RUNNER_TEMP` variables, each step's `if:`
(`always()`, `success()`, comparisons with inputs) and the outputs. Uses the reference server
on ports 8897-8899, the `restep-check` in `tools/restep-check/` and doubles for `gh` and
`restep-diff`. Covers: start, check and a diff with no changes plus a new comment; a breaking
change, a missing profile and `--writes` updating the same comment; an already running API with
oauth outside a PR; an API that fails to start; `fail-on-error: false`; a failing MUST; and an
API with major version 2 whose discovery sits behind a `service-desc` (with a `data:` one in
front that is not followed and one on another origin that gets no credentials). What the
reference announces (profiles and extensions) is read from its discovery, not written into the
test.

## Limits

- `bash` only: Windows runners need Git Bash (GitHub's ship it).
- The API started with `start-command` is stopped by sending `SIGTERM` to its process group;
  if it leaves child processes in another group, the runner collects them when the job ends.
- The comment is found by a marker holding the API URL: two runs of the action with the same
  `url` on the same PR share a comment.
- It has not run on real GitHub: the test simulates the runner.

## Draft 6

The action is not an API client: it delegates to restep-check (conformance) and restep-diff
(compatibility). Of the client requirements in §12.2, the ones about fetching the discovery apply,
and it meets them (JSON object with a string `restep`, first `service-desc` that is a discovery,
link schemes from §3, credentials only to the origin per §4.3). It uses no experimental part and
writes nothing to the API. If the declared version is not Restep 1, the summary says so; the one
that fails the check is restep-check (`discovery.version`).

## Questions about the spec

- §5.5 says which changes are breaking, but not whether an API must publish its previous
  discovery or how to get it: the action relies on the repository keeping it or on an
  environment with the base version deployed.

## Code and issues

Code and issues: <https://github.com/restep-spec/restep-action>. That repository is generated from the Restep
site, where the tool is developed alongside the [specification](https://restep.wubytes.com/1/) and the reference
server: `vendor/` and `schema/` are copies from the site so the tests run on their own.

MIT licensed.

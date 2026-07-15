# headless-mfa

`headless-mfa` renews a short-lived session for a protected web application
from a longer-lived browser SSO session. You complete password and MFA login
manually once per SSO lifetime. Later calls run Chromium headlessly and reuse
that saved SSO session.

The utility never stores a password or OTP, does not generate MFA codes, and
does not extend any server-configured lifetime.

## How it works

1. `login` opens a persistent Chromium profile for the manual SSO login.
2. The browser cookies and local storage are saved in a private state directory,
   including session-only identity-provider cookies.
3. `refresh` removes only the short-lived application credential and visits the
   site. The still-valid SSO browser session follows the normal login redirects
   and creates a new application session without another MFA prompt.
4. `token` exports the current credential, while `fetch` keeps the credential in
   the browser and performs an authenticated same-origin request.

Some protected services enforce network allowlists or return HTTP `403` before
authentication. Run and verify the end-to-end login from a host that is
permitted to reach the protected service.

## Requirements

- A host permitted to reach the protected service, if it enforces a network allowlist
- Node.js 22 or 24 recommended
- Outbound HTTPS access for `npm` and the Chromium download
- A graphical desktop, VNC desktop, or working SSH X forwarding for `login`
- About 350 MB for the Playwright Chromium installation

Headless `token`, `refresh`, `fetch`, and `inspect` calls do not require a
display after the initial login.

### macOS

The utility supports macOS 14 (Sonoma) or later on both Apple Silicon and Intel.
Install Node.js 22 or 24, then use the same extraction and installation commands
below. `npm run browser:install` detects the machine architecture and downloads
the matching macOS Chromium build; do not copy `.browsers/` from Linux.

On a Mac, `login` opens Chromium directly on the desktop, so X forwarding or VNC
is not needed. The Mac must still have whatever network access the protected
service requires, directly or through a VPN.

Verify the transferred archive with the macOS-provided checksum tool:

```bash
shasum -a 256 -c headless-mfa-0.1.0.tar.gz.sha256
```

## Install

### Clone from GitHub

```bash
git clone https://github.com/dingp/headless-mfa.git
cd headless-mfa
npm ci
npm run browser:install
```

### Install a release archive

Download `headless-mfa-0.1.0.tar.gz` and its `.sha256` file from the
[v0.1.0 release](https://github.com/dingp/headless-mfa/releases/tag/v0.1.0), copy
both files to the target host, then:

```bash
tar -xzf headless-mfa-0.1.0.tar.gz
cd headless-mfa-0.1.0
npm ci
npm run browser:install
```

The archive intentionally excludes `.state/`, `.browsers/`, `node_modules/`,
and all browser credentials. Verify it after transfer with the adjacent checksum:

```bash
sha256sum -c headless-mfa-0.1.0.tar.gz.sha256
```

`npm run browser:install` stores Chromium in this directory's `.browsers/`.

## Establish the SSO session

From a host that can reach the protected service, run this in a terminal with a
display:

```bash
./headless-mfa login --url https://protected.example/
```

The browser opens the configured protected URL. Complete the SSO password and
MFA prompts in that browser only. When the protected page is fully loaded,
return to the terminal and press Enter. The command verifies the protected
origin and saves the browser state.

If the instance requires an explicit login path, use:

```bash
./headless-mfa login \
  --url https://protected.example/ \
  --login-url https://sso.example/login
```

Never put a password or MFA value on this command line.

## Inspect the session safely

After login, identify the credential names and expiry times:

```bash
./headless-mfa inspect
```

The report redacts values. Use the cookie, authorization, or browser-storage
names reported by the protected service.

## Renew the short session

Force a new short-lived application session through the saved SSO session:

```bash
./headless-mfa refresh \
  --url https://protected.example/ \
  --name app_session \
  --format value \
  --output .state/app-session
```

By default, `refresh` clears the utility's default short-lived cookie names
before navigating. For a different cookie-based service, specify its
short-lived cookie name:

```bash
./headless-mfa refresh \
  --url https://protected.example/ \
  --clear-cookie app_session \
  --name app_session \
  --format value \
  --output .state/app-session
```

The output file is written with mode `0600`. When the 24-hour SSO session has
expired, the command exits with status `2`; run `login` and complete MFA again.

Some SSO-backed sites keep their short-lived credential in browser storage
instead of a cookie. Clear the site-specific `localStorage` key during refresh,
then export the replacement credential. Use the key reported by `inspect`:

```bash
./headless-mfa refresh \
  --url https://protected.example/ \
  --clear-storage app-auth-token \
  --name app-auth-token \
  --format value \
  --output .state/app-session
```

`--clear-storage` removes only the named key on the configured origin. When it
is used without `--clear-cookie`, the refresh does not clear the default
cookie set. The browser runs headlessly by default and follows the
normal SSO redirect using the saved browser session. If that SSO session has
expired, complete `login` again.

To export all request headers instead:

```bash
./headless-mfa refresh --format header
```

To write a curl-compatible cookie jar:

```bash
./headless-mfa refresh \
  --url https://protected.example/ \
  --format netscape \
  --output .state/app.cookie-jar

curl --cookie .state/app.cookie-jar \
  https://protected.example/api/resource
```

`token` has the same output options but does not discard the current short
session first:

```bash
./headless-mfa token --format json --output .state/current-session.json
```

## Make requests without exporting a token

`fetch` is safer when the caller only needs an HTTP response. Cookies remain in
Chromium, and the request works with HttpOnly/SameSite cookies or credentials
managed by browser JavaScript:

```bash
./headless-mfa fetch --url https://protected.example/ /api/resource

./headless-mfa fetch --url https://protected.example/ /api/query \
  --method POST \
  --header 'Content-Type: application/json' \
  --data @query.json \
  --output response.json
```

Requests are restricted to the configured origin. The CLI refuses to send the
saved browser credentials to a different host.

## Automation example

Refresh shortly before a job, then use the private cookie jar:

```bash
#!/bin/sh
set -eu

cd /path/to/headless-mfa-0.1.0
./headless-mfa refresh \
  --url https://protected.example/ \
  --format netscape \
  --output .state/app.cookie-jar

curl --fail --silent --show-error \
  --cookie .state/app.cookie-jar \
  https://protected.example/api/resource
```

Do not run overlapping commands against one state directory. The CLI rejects
concurrent use to prevent Chromium profile corruption.

## Configuration and security

Supported environment variables:

```text
HEADLESS_MFA_URL
HEADLESS_MFA_STATE_DIR
HEADLESS_MFA_BROWSER
PLAYWRIGHT_BROWSERS_PATH
```

Example with state outside the source tree:

```bash
HEADLESS_MFA_STATE_DIR="$HOME/.local/state/headless-mfa" \
./headless-mfa refresh --format header
```

The default `.state/` directory is forced to mode `0700`; exported credentials
and browser storage state are mode `0600`. Treat the entire state directory as a
bearer credential. Do not place it on a shared filesystem, commit it, include it
in backups with broad access, or expose it through a TCP service on a multi-user
node.

Use `./headless-mfa help` for the complete option list.

## Test and release automation

GitHub Actions runs syntax checks and the test suite on Node.js 20, 22, and 24
for pushes to `main` and pull requests targeting `main`.

To publish a release, update the `version` in `package.json`, commit the
change, and push a matching annotated or lightweight tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The release workflow requires the tag to match the package version, reruns the
checks, builds the source archive, verifies its SHA-256 checksum, and attaches
both the `.tar.gz` archive and its `.sha256` file to a GitHub release.

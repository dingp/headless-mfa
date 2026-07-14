# headless-mfa

`headless-mfa` renews the short-lived session for
`https://grafana-mfa.nersc.gov/` from a longer-lived NERSC browser SSO session.
You complete password and MFA login manually once per SSO lifetime. Later calls
run Chromium headlessly and reuse that saved SSO session.

The utility never stores a password or OTP, does not generate MFA codes, and
does not extend any server-configured lifetime.

## How it works

1. `login` opens a persistent Chromium profile for the manual NERSC login.
2. The browser cookies and local storage are saved in a private state directory,
   including session-only identity-provider cookies.
3. `refresh` removes only the short-lived Grafana cookies and visits the site.
   The still-valid SSO browser session follows the normal login redirects and
   creates a new Grafana session without another MFA prompt.
4. `token` exports the current credential, while `fetch` keeps the credential in
   the browser and performs an authenticated same-origin request.

The current development node is outside the IP allowlist for the separate
`grafana-mfa.nersc.gov` instance. It returns HTTP `403` before authentication, so
the end-to-end login must be run and verified on an allowlisted node.

## Requirements

- A node whose source IP is allowed to reach `grafana-mfa.nersc.gov`
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
is not needed. The Mac's egress IP must still be allowed to reach the protected
host (directly or through the required facility network/VPN).

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
both files to the allowlisted node, then:

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

From the allowlisted node, run this in a terminal with a display:

```bash
./headless-mfa login
```

The browser opens `https://grafana-mfa.nersc.gov/` by default. Complete the
NERSC password and MFA prompts in that browser only. When the Grafana page is
fully loaded, return to the terminal and press Enter. The command verifies the
protected origin and saves the browser state.

If the instance requires an explicit login path, use:

```bash
./headless-mfa login \
  --login-url https://grafana-mfa.nersc.gov/login
```

Never put a password or MFA value on this command line.

## Inspect the session safely

After login, identify the credential names and expiry times:

```bash
./headless-mfa inspect
```

The report redacts values. Standard Grafana installations normally use
`grafana_session` and `grafana_session_expiry`; use the names reported by this
instance if they differ.

## Renew the short session

Force a new short-lived Grafana session through the saved SSO session:

```bash
./headless-mfa refresh \
  --name grafana_session \
  --format value \
  --output .state/grafana-session
```

By default, `refresh` clears `grafana_session` and
`grafana_session_expiry` before navigating. For different cookie names:

```bash
./headless-mfa refresh \
  --clear-cookie CUSTOM_SESSION_COOKIE \
  --name CUSTOM_SESSION_COOKIE \
  --format value \
  --output .state/grafana-session
```

The output file is written with mode `0600`. When the 24-hour SSO session has
expired, the command exits with status `2`; run `login` and complete MFA again.

To export all request headers instead:

```bash
./headless-mfa refresh --format header
```

To write a curl-compatible cookie jar:

```bash
./headless-mfa refresh \
  --format netscape \
  --output .state/grafana.cookie-jar

curl --cookie .state/grafana.cookie-jar \
  https://grafana-mfa.nersc.gov/api/search
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
./headless-mfa fetch /api/search

./headless-mfa fetch /api/ds/query \
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
  --format netscape \
  --output .state/grafana.cookie-jar

curl --fail --silent --show-error \
  --cookie .state/grafana.cookie-jar \
  https://grafana-mfa.nersc.gov/api/search
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

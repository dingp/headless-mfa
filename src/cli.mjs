#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  AuthenticationRequiredError,
  CliError,
  DEFAULT_REFRESH_COOKIES,
  DEFAULT_TARGET,
  acquireLock,
  credentialOutput,
  decodeJwtMetadata,
  ensurePrivateDirectory,
  normalizeHttpsUrl,
  parseDuration,
  parseHeader,
  readJsonIfPresent,
  redactValue,
  resolveFetchUrl,
  secureWrite,
  suspectedStorageCredentials,
  uniqueAuthorizationHeaders,
} from './lib.mjs';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_STATE_DIR = resolve(PROJECT_ROOT, '.state');
const DEFAULT_BROWSER_DIR = resolve(PROJECT_ROOT, '.browsers');
const COMMANDS = new Set(['login', 'token', 'refresh', 'fetch', 'inspect', 'help']);

const HELP = `Usage: headless-mfa <command> [options]

Commands:
  login                 Open Chromium for manual SSO/MFA, then save its session
  token                 Visit the site and print/export its current credential
  refresh               Clear the short site session, renew it through SSO, and export it
  fetch <path-or-url>   Make a same-origin request inside the authenticated browser
  inspect               Show cookie/storage/header metadata without exposing secrets
  help                  Show this help

Common options:
  --url URL             Protected origin (default: ${DEFAULT_TARGET})
  --state-dir DIR       Browser and session state (default: ${DEFAULT_STATE_DIR})
  --timeout DURATION    Navigation timeout, such as 30s or 2m (default: 60s)
  --headful             Show the browser for token, fetch, or inspect

Login options:
  --login-url URL       Browser authentication entry point (default: --url)

Token options:
  --format FORMAT       header, value, json, or netscape (default: header)
  --name NAME           Select one cookie or browser-storage key
  --output FILE         Write output securely instead of stdout

Refresh options:
  --clear-cookie NAME   Short-lived cookie to clear; repeat as needed
                        (default: ${DEFAULT_REFRESH_COOKIES.join(', ')})
  --clear-storage NAME  Browser localStorage key to clear; repeat as needed
                        (useful for SSO-backed browser tokens)

Fetch options:
  --method METHOD       HTTP method (default: GET)
  --header 'N: value'   Request header; repeat as needed
  --data STRING|@FILE   Request body
  --output FILE         Write response securely instead of stdout

Inspect options:
  --show-secrets        Include raw credential values (unsafe for terminal logs)

Environment:
  HEADLESS_MFA_URL, HEADLESS_MFA_STATE_DIR, HEADLESS_MFA_BROWSER,
  PLAYWRIGHT_BROWSERS_PATH
`;

function log(message) {
  process.stderr.write(`${message}\n`);
}

function parseArguments(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') return { command: 'help', options: {}, positional: [] };
  const command = argv[0] ?? 'help';
  if (!COMMANDS.has(command)) throw new CliError(`Unknown command: ${command}\n\n${HELP}`);

  const booleanOptions = new Set(['headful', 'show-secrets']);
  const repeatableOptions = new Set(['header', 'clear-cookie', 'clear-storage']);
  const allowedOptions = {
    login: new Set(['url', 'state-dir', 'timeout', 'login-url']),
    token: new Set(['url', 'state-dir', 'timeout', 'headful', 'format', 'name', 'output']),
    refresh: new Set([
      'url',
      'state-dir',
      'timeout',
      'headful',
      'format',
      'name',
      'output',
      'clear-cookie',
      'clear-storage',
    ]),
    fetch: new Set(['url', 'state-dir', 'timeout', 'headful', 'method', 'header', 'data', 'output']),
    inspect: new Set(['url', 'state-dir', 'timeout', 'headful', 'show-secrets']),
    help: new Set(),
  };
  const options = { header: [], 'clear-cookie': [], 'clear-storage': [] };
  const positional = [];

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }

    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (!allowedOptions[command].has(name)) {
      throw new CliError(`Unknown option for ${command}: --${name}`);
    }
    if (booleanOptions.has(name)) {
      if (equals !== -1) throw new CliError(`Option --${name} does not take a value`);
      options[name] = true;
      continue;
    }

    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (value === undefined || value.startsWith('--')) {
      throw new CliError(`Option --${name} requires a value`);
    }
    if (repeatableOptions.has(name)) options[name].push(value);
    else options[name] = value;
  }

  if (command !== 'fetch' && positional.length > 0) {
    throw new CliError(`${command} does not accept positional arguments`);
  }

  return { command, options, positional };
}

function makeConfig(options) {
  const target = normalizeHttpsUrl(options.url ?? process.env.HEADLESS_MFA_URL ?? DEFAULT_TARGET);
  const stateDir = resolve(
    options['state-dir'] ?? process.env.HEADLESS_MFA_STATE_DIR ?? DEFAULT_STATE_DIR,
  );
  const timeout = parseDuration(options.timeout ?? '60s');
  if (timeout < 1_000) throw new CliError('--timeout must be at least 1s');

  return {
    target,
    stateDir,
    profileDir: resolve(stateDir, 'browser-profile'),
    storageStatePath: resolve(stateDir, 'storage-state.json'),
    lockPath: resolve(stateDir, 'browser.lock'),
    timeout,
    headful: Boolean(options.headful),
    executablePath: process.env.HEADLESS_MFA_BROWSER,
  };
}

async function findBrowser(config) {
  if (config.executablePath) {
    await access(config.executablePath, constants.X_OK);
    return config.executablePath;
  }

  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = DEFAULT_BROWSER_DIR;
  }
  const { chromium } = await import('playwright');
  const executablePath = chromium.executablePath();
  try {
    await access(executablePath, constants.X_OK);
  } catch {
    throw new CliError(
      `Chromium is not installed. Run "npm run browser:install" in ${PROJECT_ROOT}.`,
    );
  }
  return executablePath;
}

async function restoreBrowserState(context, config) {
  const state = await readJsonIfPresent(config.storageStatePath);
  if (!state) return;
  if (Array.isArray(state.cookies) && state.cookies.length > 0) {
    await context.addCookies(state.cookies);
  }
  if (Array.isArray(state.origins) && state.origins.length > 0) {
    await context.addInitScript((origins) => {
      const saved = origins.find((entry) => entry.origin === window.location.origin);
      for (const item of saved?.localStorage ?? []) {
        window.localStorage.setItem(item.name, item.value);
      }
    }, state.origins);
  }
}

async function saveBrowserState(context, config) {
  const state = await context.storageState();
  await secureWrite(config.storageStatePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function withBrowser(config, headless, callback) {
  await ensurePrivateDirectory(config.stateDir);
  await ensurePrivateDirectory(config.profileDir);
  const releaseLock = await acquireLock(config.lockPath);
  let context;

  try {
    const executablePath = await findBrowser(config);
    const { chromium } = await import('playwright');
    context = await chromium.launchPersistentContext(config.profileDir, {
      acceptDownloads: false,
      executablePath,
      headless,
      viewport: { width: 1280, height: 900 },
    });
    await restoreBrowserState(context, config);
    return await callback(context);
  } catch (error) {
    if (/Missing X server|cannot open display|DISPLAY/i.test(error.message)) {
      throw new CliError(
        `Cannot open a graphical browser. Reconnect with X forwarding or run login on a desktop: ${error.message}`,
      );
    }
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    await releaseLock();
  }
}

function attachAuthorizationCapture(context, target) {
  const authorization = [];
  const attach = (page) => {
    page.on('request', (request) => {
      try {
        if (new URL(request.url()).origin !== target.origin) return;
        const value = request.headers().authorization;
        if (value) authorization.push(value);
      } catch {
        // Ignore browser-internal request URLs.
      }
    });
  };
  for (const page of context.pages()) attach(page);
  context.on('page', attach);
  return authorization;
}

async function navigateToTarget(page, target, timeout) {
  const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 5_000) }).catch(() => {});

  const finalUrl = new URL(page.url());
  if (finalUrl.origin !== target.origin) {
    throw new AuthenticationRequiredError(
      `SSO login is required; navigation ended at ${finalUrl.href}. Run "headless-mfa login".`,
    );
  }
  if (!response || response.status() >= 400) {
    throw new AuthenticationRequiredError(
      `The protected site returned HTTP ${response?.status() ?? 'unknown'}. Run "headless-mfa login".`,
    );
  }
  return response;
}

async function browserStorage(page) {
  return page.evaluate(() => {
    const local = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      local.push({ key, value: window.localStorage.getItem(key), storage: 'localStorage' });
    }
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      local.push({ key, value: window.sessionStorage.getItem(key), storage: 'sessionStorage' });
    }
    return local;
  });
}

async function collectCredentials(context, page, target, authorization) {
  return {
    cookies: await context.cookies(target.href),
    authorization: uniqueAuthorizationHeaders(authorization),
    storage: await browserStorage(page),
  };
}

async function runLogin(config, options) {
  if (!stdin.isTTY) {
    throw new CliError('The login command requires an interactive terminal for the manual MFA step.');
  }
  const loginUrl = normalizeHttpsUrl(options['login-url'] ?? config.target.href, 'login URL');

  return withBrowser(config, false, async (context) => {
    const page = context.pages()[0] ?? (await context.newPage());
    log(`Opening ${loginUrl.href}`);
    await page.goto(loginUrl.href, { waitUntil: 'domcontentloaded', timeout: config.timeout }).catch((error) => {
      log(`Initial page load did not complete: ${error.message}`);
    });

    const readline = createInterface({ input: stdin, output: stdout });
    try {
      while (true) {
        const answer = await readline.question(
          `Complete the browser login and MFA, then press Enter to verify ${config.target.origin} (q to quit): `,
        );
        if (answer.trim().toLowerCase() === 'q') throw new CliError('Login cancelled.');
        if (page.isClosed()) throw new CliError('The browser was closed before the session was saved.');

        try {
          // Preserve session-only IdP cookies before navigating away or closing Chromium.
          await saveBrowserState(context, config);
          await navigateToTarget(page, config.target, config.timeout);
          await saveBrowserState(context, config);
          log(`Authenticated browser state saved in ${config.stateDir}`);
          return;
        } catch (error) {
          if (!(error instanceof AuthenticationRequiredError)) throw error;
          log(`Verification failed: ${error.message}`);
          log('Finish the login in the browser, or use --login-url with the correct SSO entry page.');
        }
      }
    } finally {
      readline.close();
    }
  });
}

async function clearShortSession(context, config, names) {
  const wanted = new Set(names);
  const cookies = await context.cookies(config.target.href);
  const matches = cookies.filter((cookie) => wanted.has(cookie.name));
  for (const cookie of matches) {
    await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
  }
  log(
    matches.length > 0
      ? `Cleared short-lived cookie(s): ${matches.map(({ name }) => name).join(', ')}`
      : `No matching short-lived cookie was present (${names.join(', ')})`,
  );
}

async function clearBrowserStorageForNavigation(context, page, config, names) {
  const marker = `headless-mfa-storage-cleared-${process.pid}-${Date.now()}`;
  await context.addInitScript(
    ({ origin, names: storageNames, marker: clearMarker }) => {
      if (window.location.origin !== origin || window.sessionStorage.getItem(clearMarker)) return;
      for (const name of storageNames) window.localStorage.removeItem(name);
      window.sessionStorage.setItem(clearMarker, '1');
    },
    { origin: config.target.origin, names, marker },
  );
  await navigateToTarget(page, config.target, config.timeout);
  log(`Cleared browser-storage key(s): ${names.join(', ')}`);
}

async function runToken(config, options, forceRefresh = false) {
  const format = options.format ?? 'header';
  return withBrowser(config, !config.headful, async (context) => {
    const page = context.pages()[0] ?? (await context.newPage());
    if (forceRefresh) {
      const cookieNames = options['clear-cookie'].length
        ? options['clear-cookie']
        : options['clear-storage'].length
          ? []
          : DEFAULT_REFRESH_COOKIES;
      if (cookieNames.length > 0) await clearShortSession(context, config, cookieNames);
      if (options['clear-storage'].length > 0) {
        await clearBrowserStorageForNavigation(context, page, config, options['clear-storage']);
      }
    }
    const authorization = attachAuthorizationCapture(context, config.target);
    await navigateToTarget(page, config.target, config.timeout);
    await page.waitForTimeout(500);
    const bundle = await collectCredentials(context, page, config.target, authorization);
    await saveBrowserState(context, config);
    const output = credentialOutput(bundle, format, options.name);
    await emitOutput(output, options.output);
  });
}

async function readBodyOption(value) {
  if (value === undefined) return undefined;
  if (value.startsWith('@')) return readFile(value.slice(1), 'utf8');
  return value;
}

async function runFetch(config, options, positional) {
  if (positional.length !== 1) {
    throw new CliError('fetch requires exactly one path or URL');
  }
  const requestUrl = resolveFetchUrl(config.target, positional[0]);
  const headers = Object.fromEntries(options.header.map(parseHeader));
  const method = (options.method ?? 'GET').toUpperCase();
  const body = await readBodyOption(options.data);

  return withBrowser(config, !config.headful, async (context) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await navigateToTarget(page, config.target, config.timeout);
    const result = await page.evaluate(
      async ({ url, method: fetchMethod, headers: fetchHeaders, body: fetchBody }) => {
        const response = await window.fetch(url, {
          method: fetchMethod,
          headers: fetchHeaders,
          body: fetchBody,
          credentials: 'include',
          redirect: 'follow',
        });
        return {
          body: await response.text(),
          contentType: response.headers.get('content-type'),
          status: response.status,
          url: response.url,
        };
      },
      { url: requestUrl.href, method, headers, body },
    );

    const finalOrigin = new URL(result.url).origin;
    if (finalOrigin !== config.target.origin) {
      throw new AuthenticationRequiredError(`Request was redirected to ${result.url}`);
    }
    await saveBrowserState(context, config);
    log(`HTTP ${result.status} ${requestUrl.href}${result.contentType ? ` (${result.contentType})` : ''}`);
    await emitOutput(result.body, options.output);
    if (result.status >= 400) throw new CliError(`Request failed with HTTP ${result.status}`, 5);
  });
}

async function runInspect(config, options) {
  return withBrowser(config, !config.headful, async (context) => {
    const authorization = attachAuthorizationCapture(context, config.target);
    const page = context.pages()[0] ?? (await context.newPage());
    const response = await navigateToTarget(page, config.target, config.timeout);
    await page.waitForTimeout(500);
    const bundle = await collectCredentials(context, page, config.target, authorization);
    await saveBrowserState(context, config);

    const showSecrets = Boolean(options['show-secrets']);
    const report = {
      page: {
        url: page.url(),
        status: response.status(),
        title: await page.title(),
      },
      cookies: bundle.cookies.map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        expiresAt: cookie.expires > 0 ? new Date(cookie.expires * 1_000).toISOString() : 'browser-session',
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
        value: redactValue(cookie.value, showSecrets),
        jwt: decodeJwtMetadata(cookie.value),
      })),
      authorization: uniqueAuthorizationHeaders(bundle.authorization).map((value) => ({
        scheme: value.split(/\s+/, 1)[0],
        value: redactValue(value, showSecrets),
        jwt: decodeJwtMetadata(value),
      })),
      storage: suspectedStorageCredentials(bundle.storage).map((entry) => ({
        key: entry.key,
        storage: entry.storage,
        value: redactValue(entry.value, showSecrets),
        jwt: decodeJwtMetadata(entry.value),
      })),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  });
}

async function emitOutput(data, path) {
  if (path) {
    await secureWrite(path, data);
    log(`Wrote ${path} with mode 0600`);
  } else {
    process.stdout.write(data);
  }
}

async function main() {
  const { command, options, positional } = parseArguments(process.argv.slice(2));
  if (command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const config = makeConfig(options);

  if (command === 'login') return runLogin(config, options);
  if (command === 'token') return runToken(config, options);
  if (command === 'refresh') return runToken(config, options, true);
  if (command === 'fetch') return runFetch(config, options, positional);
  if (command === 'inspect') return runInspect(config, options);
}

main().catch((error) => {
  const detail = error instanceof CliError ? error.message : error.stack ?? error.message;
  log(`headless-mfa: ${detail}`);
  process.exitCode = error.exitCode ?? 1;
});

import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CliError,
  cookieHeader,
  credentialOutput,
  decodeJwtMetadata,
  normalizeHttpsUrl,
  parseDuration,
  resolveFetchUrl,
  secureWrite,
  suspectedStorageCredentials,
  toNetscapeCookieJar,
} from '../src/lib.mjs';

test('parseDuration supports milliseconds, seconds, and minutes', () => {
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('2m'), 120_000);
  assert.throws(() => parseDuration('1h'), CliError);
});

test('URLs are restricted to HTTPS and fetches are same-origin', () => {
  const target = normalizeHttpsUrl('https://grafana-mfa.nersc.gov/base');
  assert.equal(resolveFetchUrl(target, '/api/search').href, 'https://grafana-mfa.nersc.gov/api/search');
  assert.throws(() => normalizeHttpsUrl('http://grafana-mfa.nersc.gov'), /HTTPS/);
  assert.throws(() => resolveFetchUrl(target, 'https://example.org/steal'), /Refusing/);
});

test('cookie serializers preserve values and curl-compatible HttpOnly markers', () => {
  const cookies = [
    {
      name: 'session',
      value: 'a=b+c',
      domain: 'grafana-mfa.nersc.gov',
      path: '/',
      expires: 1_800_000_000,
      httpOnly: true,
      secure: true,
    },
  ];
  assert.equal(cookieHeader(cookies), 'session=a=b+c');
  assert.match(toNetscapeCookieJar(cookies), /#HttpOnly_grafana-mfa\.nersc\.gov\tFALSE\t\/\tTRUE/);
});

test('credential output selects a named cookie', () => {
  const bundle = {
    cookies: [
      { name: 'one', value: '1' },
      { name: 'two', value: '2' },
    ],
    authorization: ['Bearer third'],
    storage: [],
  };
  assert.equal(credentialOutput(bundle, 'value', 'two'), '2\n');
  assert.equal(
    credentialOutput(bundle, 'header'),
    'Cookie: one=1; two=2\nAuthorization: Bearer third\n',
  );
});

test('storage credential detection is conservative', () => {
  const entries = [
    { key: 'theme', value: 'dark' },
    { key: 'access_token', value: 'secret' },
    { key: 'grafana.session', value: 'secret2' },
  ];
  assert.deepEqual(suspectedStorageCredentials(entries).map(({ key }) => key), [
    'access_token',
    'grafana.session',
  ]);
});

test('JWT metadata is decoded without treating malformed values as tokens', () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'user', exp: 1_800_000_000 })).toString('base64url');
  assert.equal(decodeJwtMetadata(`x.${payload}.y`).subject, 'user');
  assert.equal(decodeJwtMetadata('not-a-jwt'), undefined);
});

test('secureWrite creates private files and rejects an existing symlink', async () => {
  const directory = join(tmpdir(), `headless-mfa-test-${process.pid}-${Date.now()}`);
  await mkdir(directory, { mode: 0o755 });
  const originalDirectoryMode = (await lstat(directory)).mode & 0o777;
  const path = join(directory, 'secret');
  await secureWrite(path, 'credential\n');
  assert.equal(await readFile(path, 'utf8'), 'credential\n');
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(directory)).mode & 0o777, originalDirectoryMode);

  const target = join(directory, 'target');
  const link = join(directory, 'link');
  await secureWrite(target, 'safe');
  await symlink(target, link);
  await assert.rejects(() => secureWrite(link, 'unsafe'), /symbolic link/);
});

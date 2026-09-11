import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAllowedUrl,
  isHostnameAllowed,
  isPathAllowed,
  matchingHostPattern,
  normalizeAllowedPaths,
  normalizeHostPatterns,
  normalizePathPattern
} from '../src/hosts.js';

test('exact hosts include every path but not sibling hosts by default', () => {
  const patterns = normalizeHostPatterns(['jira.example.com']);
  assert.equal(isHostnameAllowed('jira.example.com', patterns), true);
  assert.equal(isHostnameAllowed('other.example.com', patterns), false);
  assert.equal(assertAllowedUrl('https://jira.example.com/a/b?x=1', patterns).hostname, 'jira.example.com');
});

test('wildcard hosts include subdomains but not the root hostname', () => {
  const patterns = normalizeHostPatterns(['*.internal.example.com']);
  assert.equal(isHostnameAllowed('one.internal.example.com', patterns), true);
  assert.equal(isHostnameAllowed('deep.one.internal.example.com', patterns), true);
  assert.equal(isHostnameAllowed('internal.example.com', patterns), false);
});

test('missing or empty allowed_paths entry allows every path on an allowed host', () => {
  const hosts = normalizeHostPatterns(['github.com', '*.github.com']);
  const paths = normalizeAllowedPaths({ 'github.com': [] }, hosts);

  assert.doesNotThrow(() => assertAllowedUrl('https://github.com/other/repo', hosts, paths));
  assert.doesNotThrow(() => assertAllowedUrl('https://api.github.com/repos/other/repo', hosts, paths));
});

test('non-empty allowed_paths entry restricts a host to exact and recursive-prefix paths', () => {
  const hosts = normalizeHostPatterns(['github.com']);
  const paths = normalizeAllowedPaths({
    'github.com': [
      '/dominikduda/savage_scraper',
      '/dominikduda/savage_scraper/**'
    ]
  }, hosts);

  assert.doesNotThrow(() => assertAllowedUrl('https://github.com/dominikduda/savage_scraper', hosts, paths));
  assert.doesNotThrow(() => assertAllowedUrl('https://github.com/dominikduda/savage_scraper/issues/1?x=1#y', hosts, paths));
  assert.throws(
    () => assertAllowedUrl('https://github.com/dominikduda/other', hosts, paths),
    /Path is not allowed/
  );
});

test('the most specific matching host pattern controls path restrictions', () => {
  const hosts = normalizeHostPatterns(['*.example.com', '*.internal.example.com', 'api.internal.example.com']);
  const paths = normalizeAllowedPaths({
    '*.example.com': [],
    '*.internal.example.com': ['/shared/**'],
    'api.internal.example.com': ['/safe/**']
  }, hosts);

  assert.equal(matchingHostPattern('api.internal.example.com', hosts), 'api.internal.example.com');
  assert.equal(matchingHostPattern('one.internal.example.com', hosts), '*.internal.example.com');
  assert.doesNotThrow(() => assertAllowedUrl('https://api.internal.example.com/safe/x', hosts, paths));
  assert.throws(() => assertAllowedUrl('https://api.internal.example.com/shared/x', hosts, paths));
  assert.doesNotThrow(() => assertAllowedUrl('https://one.internal.example.com/shared/x', hosts, paths));
  assert.throws(() => assertAllowedUrl('https://one.internal.example.com/other', hosts, paths));
});

test('path matching is case-sensitive and ignores URL query and fragment', () => {
  assert.equal(isPathAllowed('/Repo/File', ['/Repo/**']), true);
  assert.equal(isPathAllowed('/repo/file', ['/Repo/**']), false);
});

test('allowed_paths keys must also appear in allowed_hosts', () => {
  const hosts = normalizeHostPatterns(['github.com']);
  assert.throws(
    () => normalizeAllowedPaths({ 'api.github.com': ['/repos/**'] }, hosts),
    /must also appear in allowed_hosts/
  );
});

test('invalid path wildcards, queries and fragments are rejected', () => {
  assert.throws(() => normalizePathPattern('repo/**'));
  assert.throws(() => normalizePathPattern('/repo/*'));
  assert.throws(() => normalizePathPattern('/repo/**/issues'));
  assert.throws(() => normalizePathPattern('/repo?tab=readme'));
  assert.throws(() => normalizePathPattern('/repo#readme'));
});

test('global wildcards are rejected', () => {
  assert.throws(() => normalizeHostPatterns(['*']));
});

test('non-http schemes are rejected', () => {
  const patterns = normalizeHostPatterns(['example.com']);
  assert.throws(() => assertAllowedUrl('file:///tmp/a', patterns));
});

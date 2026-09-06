import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAllowedUrl,
  isHostnameAllowed,
  normalizeHostPatterns
} from '../src/hosts.js';

test('exact hosts include every path but not sibling hosts', () => {
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

test('global wildcards are rejected', () => {
  assert.throws(() => normalizeHostPatterns(['*']));
});

test('non-http schemes are rejected', () => {
  const patterns = normalizeHostPatterns(['example.com']);
  assert.throws(() => assertAllowedUrl('file:///tmp/a', patterns));
});

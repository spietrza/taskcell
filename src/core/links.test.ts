import { describe, expect, it } from 'vitest';
import { ciRunUrl, diffUrlFor, httpsUrl } from './links.js';

describe('diffUrlFor', () => {
  it('GitHub pull request → Files changed', () => {
    expect(diffUrlFor('https://github.com/o/r/pull/12')).toBe('https://github.com/o/r/pull/12/files');
  });
  it('GitLab merge request → Changes', () => {
    expect(diffUrlFor('https://gitlab.com/g/p/-/merge_requests/3')).toBe('https://gitlab.com/g/p/-/merge_requests/3/diffs');
    expect(diffUrlFor('https://gl.example.com/a/b/c/-/merge_requests/3/')).toBe('https://gl.example.com/a/b/c/-/merge_requests/3/diffs');
  });
  it.each([undefined, '', 'not a url', 'http://github.com/o/r/pull/1', 'https://github.com/o/r/issues/1'])('no address for %j', (v) => {
    expect(diffUrlFor(v)).toBeUndefined();
  });
});

describe('ciRunUrl', () => {
  it('GitHub Actions run', () => {
    expect(ciRunUrl({ GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '99' })).toBe(
      'https://github.com/o/r/actions/runs/99',
    );
  });
  it('GitLab pipeline', () => {
    expect(ciRunUrl({ GITLAB_CI: 'true', CI_PIPELINE_URL: 'https://gitlab.com/g/p/-/pipelines/5' })).toBe('https://gitlab.com/g/p/-/pipelines/5');
  });
  it('no address outside CI or with a bad value', () => {
    expect(ciRunUrl({})).toBeUndefined();
    expect(ciRunUrl({ GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: 'x' })).toBeUndefined();
    expect(ciRunUrl({ GITLAB_CI: 'true', CI_PIPELINE_URL: 'javascript:1' })).toBeUndefined();
  });
});

it('httpsUrl accepts only https', () => {
  expect(httpsUrl('https://a.b/c')).toBe('https://a.b/c');
  expect(httpsUrl('ftp://a.b')).toBeUndefined();
});

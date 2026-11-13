// Addresses of a run in the Git host. Pure, no imports: the server computes them so the UI never
// builds a URL from parts (docs/hub.md § Open in the original system).

/** An absolute https URL, else undefined — a stored or env-supplied value is never trusted to be a link. */
export function httpsUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The diff page of a pull/merge request: `…/pull/N/files` on GitHub ("Files changed"),
 * `…/-/merge_requests/N/diffs` on GitLab ("Changes"). Undefined for any other address.
 */
export function diffUrlFor(prUrl: string | undefined): string | undefined {
  const url = httpsUrl(prUrl);
  if (url === undefined) return undefined;
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  const base = u.pathname.replace(/\/+$/, '');
  if (/\/pull\/\d+$/.test(base)) return `${u.origin}${base}/files`;
  if (/\/-\/merge_requests\/\d+$/.test(base)) return `${u.origin}${base}/diffs`;
  return undefined;
}

/** The CI run executing this process: a GitHub Actions run or a GitLab pipeline. Undefined outside CI. */
export function ciRunUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env['GITHUB_ACTIONS'] === 'true') {
    const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id } = env;
    if (server === undefined || repo === undefined || id === undefined || !/^\d+$/.test(id)) return undefined;
    return httpsUrl(`${server}/${repo}/actions/runs/${id}`);
  }
  if (env['GITLAB_CI'] === 'true') return httpsUrl(env['CI_PIPELINE_URL']);
  return undefined;
}

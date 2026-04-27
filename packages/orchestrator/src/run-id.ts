/**
 * Run ID generation. Bash equivalent:
 *
 *   run_id="$(date +%s)-${role}${feature_tag}"
 *
 * Where feature_tag is "-F-001" if FEATURE_ID=F-001 was passed and matches
 * /^F-[A-Z0-9-]+$/, otherwise empty.
 */

const FEATURE_ID_RE = /^F-[A-Z0-9-]+$/;

/** Extract the feature ID from extra-context args, if present and valid. */
export function extractFeatureId(extras: readonly string[]): string | null {
  for (const e of extras) {
    if (e.startsWith('FEATURE_ID=')) {
      const fid = e.slice('FEATURE_ID='.length);
      if (FEATURE_ID_RE.test(fid)) return fid;
    }
  }
  return null;
}

/** Build the run_id string. */
export function makeRunId(role: string, featureId: string | null, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const tag = featureId ? `-${featureId}` : '';
  return `${nowSeconds}-${role}${tag}`;
}

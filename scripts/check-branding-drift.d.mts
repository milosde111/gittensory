export const BASELINE_RELATIVE_PATH: string;
export const BRANDING_DRIFT_PATHSPECS: string[];

export function scanBrandingHits(options: {
  root: string;
  exec?: (root: string, args: string[]) => string;
}): Record<string, number>;

export function diffBrandingBaseline(baseline: Record<string, number>, current: Record<string, number>): string[];

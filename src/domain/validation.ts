import type { DriverDescriptor } from './driver-descriptor';

const ID_RE = /^[a-z][a-z0-9._-]*$/i;

/** Returns human-readable problems; empty means the descriptor is usable. */
export function validateDescriptor(d: DriverDescriptor): string[] {
  const problems: string[] = [];
  if (!ID_RE.test(d?.id ?? '')) problems.push(`Driver id "${d?.id}" must match ${ID_RE}.`);
  if (!d?.displayName) problems.push('Driver displayName is required.');
  if (!d?.dialect?.identifierQuote) problems.push('Driver dialect.identifierQuote is required.');
  if (!d?.dialect?.limit) problems.push('Driver dialect.limit is required.');
  const icon = d?.icon;
  const iconOk =
    icon === undefined ||
    typeof icon === 'string' ||
    (typeof icon === 'object' && icon !== null && typeof icon.light === 'string' && typeof icon.dark === 'string');
  if (!iconOk) problems.push('Driver icon must be a codicon id, an image path, or { light, dark }.');
  const seen = new Set<string>();
  for (const f of d?.connectionSchema ?? []) {
    if (!f.key) problems.push('A connection field has no key.');
    else if (seen.has(f.key)) problems.push(`Duplicate connection field "${f.key}".`);
    seen.add(f.key);
    if (f.type === 'select' && !f.options?.length) problems.push(`Field "${f.key}" is a select without options.`);
  }
  return problems;
}

/**
 * Applies defaults and coerces values to the types the schema declares.
 * Password fields are ignored here; they travel as secrets.
 */
export function normalizeOptions(
  d: DriverDescriptor,
  raw: Record<string, unknown>,
): { options: Record<string, unknown>; problems: string[] } {
  const options: Record<string, unknown> = { ...raw };
  const problems: string[] = [];

  for (const f of d.connectionSchema) {
    if (f.type === 'password') continue;

    let v = options[f.key];
    if (v === undefined || v === null || v === '') v = f.default;
    if (v === undefined) {
      if (f.required) problems.push(`"${f.label}" is required.`);
      delete options[f.key];
      continue;
    }

    switch (f.type) {
      case 'number': {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) {
          problems.push(`"${f.label}" must be a number.`);
        } else if (f.min !== undefined && n < f.min) {
          problems.push(`"${f.label}" must be at least ${f.min}.`);
        } else if (f.max !== undefined && n > f.max) {
          problems.push(`"${f.label}" must be at most ${f.max}.`);
        }
        v = n;
        break;
      }
      case 'boolean':
        v = v === true || v === 'true';
        break;
      case 'select':
        if (!f.options?.some((o) => o.value === String(v))) {
          problems.push(`"${f.label}" must be one of: ${(f.options ?? []).map((o) => o.value).join(', ')}.`);
        }
        v = String(v);
        break;
      default:
        v = String(v);
    }
    options[f.key] = v;
  }
  return { options, problems };
}

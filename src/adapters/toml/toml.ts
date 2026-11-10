import { parse, TomlError } from 'smol-toml';
import type { ParseToml } from '../../application/ports';

/** TOML 1.0 through smol-toml. A syntax error comes back with its line instead of throwing. */
export const parseToml: ParseToml = (text) => {
  try {
    return { value: parse(text) };
  } catch (e) {
    if (e instanceof TomlError) return { error: { message: e.message.split('\n')[0], line: e.line } };
    return { error: { message: e instanceof Error ? e.message : String(e) } };
  }
};

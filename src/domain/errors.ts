export class BetterSqlToolsError extends Error {
  constructor(message: string, readonly code: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

export class DriverNotFoundError extends BetterSqlToolsError {
  constructor(readonly driverId: string, detail?: string) {
    super(`Driver "${driverId}" is not installed or failed to load${detail ? `: ${detail}` : '.'}`, 'DRIVER_NOT_FOUND');
  }
}

export class ValidationError extends BetterSqlToolsError {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'), 'VALIDATION');
  }
}

/** The user backed out of something (e.g. dismissed a password prompt). Not a failure. */
export class CancelledError extends BetterSqlToolsError {
  constructor(message = 'Cancelled') {
    super(message, 'CANCELLED');
  }
}

export class LinterUnavailableError extends BetterSqlToolsError {
  constructor(readonly tool: string, hint: string) {
    super(`${tool} is not available: ${hint}`, 'LINTER_UNAVAILABLE');
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Something that is defined in a project config file cannot be changed from the UI. */
export class ProjectManagedError extends BetterSqlToolsError {
  constructor(readonly what: string, readonly file?: string) {
    super(`${what} is defined in ${file ? decodeURIComponent(file.split('/').pop() ?? file) : 'a project config file'}. Edit that file to change it.`, 'PROJECT_MANAGED');
  }
}

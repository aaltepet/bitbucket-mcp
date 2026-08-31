import winston from "winston";

const SENSITIVE_KEY_PATTERN =
  /^(authorization|proxy-authorization|password|passwd|token|access_token|refresh_token|api[_-]?key|secret|client_secret|BITBUCKET_TOKEN|BITBUCKET_PASSWORD)$/i;

const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const ATLASSIAN_TOKEN_PATTERN = /\b(ATBB|ATATT|BBAT)[A-Za-z0-9._~+/=-]+/gi;

/**
 * Encode a single URL path segment. Rejects empty values so callers cannot
 * accidentally collapse path structure.
 */
export function encodePathSegment(segment: string): string {
  if (typeof segment !== "string" || segment.trim().length === 0) {
    throw new Error("Path segment must be a non-empty string");
  }
  return encodeURIComponent(segment);
}

/**
 * Escape a value for use inside a double-quoted Bitbucket Cloud query filter.
 * See: https://developer.atlassian.com/cloud/bitbucket/rest/intro/#querying
 */
export function escapeBitbucketQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a Bitbucket repository name filter that cannot break out of the quoted value.
 */
export function buildRepositoryNameFilter(name: string): string {
  return `name~"${escapeBitbucketQueryValue(name)}"`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactString(value: string): string {
  return value
    .replace(BEARER_PATTERN, "$1 [REDACTED]")
    .replace(ATLASSIAN_TOKEN_PATTERN, "[REDACTED]");
}

/**
 * Deep-sanitize values before they are written to logs so Axios configs,
 * Authorization headers, and tokens never land on disk.
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return "[Truncated]";
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Error) {
    const errorRecord: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
    };
    if (value.stack) {
      errorRecord.stack = redactString(value.stack);
    }

    const axiosError = value as Error & {
      code?: string;
      config?: unknown;
      response?: { status?: number; statusText?: string; data?: unknown };
    };

    if (axiosError.code) {
      errorRecord.code = axiosError.code;
    }
    if (axiosError.config !== undefined) {
      errorRecord.config = sanitizeForLog(axiosError.config, depth + 1);
    }
    if (axiosError.response) {
      errorRecord.response = {
        status: axiosError.response.status,
        statusText: axiosError.response.statusText,
        data: sanitizeForLog(axiosError.response.data, depth + 1),
      };
    }

    return errorRecord;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, depth + 1));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = "[REDACTED]";
        continue;
      }
      // Axios request objects often carry sockets / streams — skip non-JSON-ish values.
      if (
        nested &&
        typeof nested === "object" &&
        !Array.isArray(nested) &&
        !(nested instanceof Error) &&
        (typeof (nested as { pipe?: unknown }).pipe === "function" ||
          typeof (nested as { _header?: unknown })._header === "string")
      ) {
        result[key] = "[Omitted]";
        continue;
      }
      result[key] = sanitizeForLog(nested, depth + 1);
    }
    return result;
  }

  return String(value);
}

/**
 * Winston format that redacts secrets from every logged info object.
 */
export const redactSecretsFormat = winston.format((info) => {
  const sanitized = sanitizeForLog(info) as Record<string, unknown>;
  Object.keys(info).forEach((key) => {
    delete (info as Record<string, unknown>)[key];
  });
  Object.assign(info, sanitized);
  return info;
});

export interface AllowedNextUrlOptions {
  /** Absolute Bitbucket API base URL (e.g. https://api.bitbucket.org/2.0) */
  baseUrl: string;
  /** Extra hostnames permitted for pagination next links */
  extraAllowedHosts?: string[];
}

/**
 * Returns true when a pagination `next` URL is safe to follow with auth headers.
 * Relative paths are allowed (resolved against the Axios baseURL). Absolute URLs
 * must match the configured API origin (protocol + host + port).
 */
export function isAllowedNextUrl(
  nextUrl: string,
  options: AllowedNextUrlOptions
): boolean {
  let configuredBase: URL;
  try {
    configuredBase = new URL(options.baseUrl);
  } catch {
    return false;
  }

  const allowedHosts = new Set<string>([
    configuredBase.host.toLowerCase(),
    ...(options.extraAllowedHosts ?? []).map((host) => host.toLowerCase()),
  ]);

  // Relative next links stay on the Axios baseURL.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(nextUrl)) {
    return nextUrl.startsWith("/");
  }

  let candidate: URL;
  try {
    candidate = new URL(nextUrl);
  } catch {
    return false;
  }

  if (candidate.username || candidate.password) {
    return false;
  }

  if (candidate.protocol !== configuredBase.protocol) {
    return false;
  }

  if (!allowedHosts.has(candidate.host.toLowerCase())) {
    return false;
  }

  return true;
}

export function assertAllowedNextUrl(
  nextUrl: string,
  options: AllowedNextUrlOptions
): void {
  if (!isAllowedNextUrl(nextUrl, options)) {
    throw new Error(
      `Refusing to follow pagination next URL outside allowlisted Bitbucket API origin: ${nextUrl}`
    );
  }
}

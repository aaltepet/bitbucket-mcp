import winston from "winston";
/**
 * Encode a single URL path segment. Rejects empty values so callers cannot
 * accidentally collapse path structure.
 */
export declare function encodePathSegment(segment: string): string;
/**
 * Escape a value for use inside a double-quoted Bitbucket Cloud query filter.
 * See: https://developer.atlassian.com/cloud/bitbucket/rest/intro/#querying
 */
export declare function escapeBitbucketQueryValue(value: string): string;
/**
 * Build a Bitbucket repository name filter that cannot break out of the quoted value.
 */
export declare function buildRepositoryNameFilter(name: string): string;
/**
 * Deep-sanitize values before they are written to logs so Axios configs,
 * Authorization headers, and tokens never land on disk.
 */
export declare function sanitizeForLog(value: unknown, depth?: number): unknown;
/**
 * Winston format that redacts secrets from every logged info object.
 */
export declare const redactSecretsFormat: winston.Logform.FormatWrap;
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
export declare function isAllowedNextUrl(nextUrl: string, options: AllowedNextUrlOptions): boolean;
export declare function assertAllowedNextUrl(nextUrl: string, options: AllowedNextUrlOptions): void;

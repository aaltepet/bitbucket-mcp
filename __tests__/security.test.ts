import {
  assertAllowedNextUrl,
  buildRepositoryNameFilter,
  encodePathSegment,
  escapeBitbucketQueryValue,
  isAllowedNextUrl,
  sanitizeForLog,
} from "../src/security.js";

describe("security helpers", () => {
  describe("encodePathSegment", () => {
    it("encodes reserved characters", () => {
      expect(encodePathSegment("acme/../admin")).toBe("acme%2F..%2Fadmin");
      expect(encodePathSegment("{uuid}")).toBe("%7Buuid%7D");
    });

    it("rejects empty segments", () => {
      expect(() => encodePathSegment("")).toThrow(/non-empty/);
      expect(() => encodePathSegment("   ")).toThrow(/non-empty/);
    });
  });

  describe("Bitbucket query escaping", () => {
    it("escapes quotes and backslashes inside filter values", () => {
      expect(escapeBitbucketQueryValue('a"b\\c')).toBe('a\\"b\\\\c');
      expect(buildRepositoryNameFilter('foo" OR name~"bar')).toBe(
        'name~"foo\\" OR name~\\"bar"'
      );
    });
  });

  describe("next URL allowlist", () => {
    const options = { baseUrl: "https://api.bitbucket.org/2.0" };

    it("allows same-origin absolute next links and relative paths", () => {
      expect(
        isAllowedNextUrl(
          "https://api.bitbucket.org/2.0/repositories/ws?page=2",
          options
        )
      ).toBe(true);
      expect(isAllowedNextUrl("/repositories/ws?page=2", options)).toBe(true);
    });

    it("rejects foreign hosts, credentialed URLs, and protocol mismatches", () => {
      expect(
        isAllowedNextUrl("https://attacker.example/exfil", options)
      ).toBe(false);
      expect(
        isAllowedNextUrl(
          "https://user:pass@api.bitbucket.org/2.0/repositories",
          options
        )
      ).toBe(false);
      expect(
        isAllowedNextUrl("http://api.bitbucket.org/2.0/repositories", options)
      ).toBe(false);
      expect(() =>
        assertAllowedNextUrl("https://evil.test/x", options)
      ).toThrow(/Refusing to follow/);
    });
  });

  describe("sanitizeForLog", () => {
    it("redacts Authorization headers and tokens from Axios-like errors", () => {
      const error = Object.assign(new Error("Request failed"), {
        config: {
          url: "https://api.bitbucket.org/2.0/user",
          headers: {
            Authorization: "Bearer ATBB-SUPER-SECRET",
            Accept: "application/json",
          },
          auth: { username: "user", password: "app-password" },
        },
      });

      const sanitized = sanitizeForLog(error) as Record<string, any>;
      const serialized = JSON.stringify(sanitized);

      expect(serialized).not.toContain("ATBB-SUPER-SECRET");
      expect(serialized).not.toContain("app-password");
      expect(sanitized.config.headers.Authorization).toBe("[REDACTED]");
      expect(sanitized.config.auth.password).toBe("[REDACTED]");
      expect(serialized).toContain("[REDACTED]");
    });
  });
});

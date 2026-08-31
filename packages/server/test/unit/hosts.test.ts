/**
 * Host matching is deliberately dumb: an exact hostname, case-insensitive,
 * and nothing else. Every test that shows something almost-matching being
 * refused is the point - a wildcard is accumulation wearing a decision's
 * paperwork.
 */
import { describe, expect, it } from "vitest";
import { exemptFromSecureTransport, hostApproved, isSecureTransport } from "../../src/gateway/Hosts.ts";

describe("the allowlist", () => {
  it("matches an exact hostname case-insensitively", () => {
    expect(hostApproved(["api.todoist.com"], "API.Todoist.COM")).toBe(true);
  });

  it("does not match a subdomain of an approved host", () => {
    // evil.api.todoist.com ends with an approved host. It is still not that
    // host, and nothing that is not that host may see the credential.
    expect(hostApproved(["api.todoist.com"], "evil.api.todoist.com")).toBe(false);
    expect(hostApproved(["todoist.com"], "api.todoist.com")).toBe(false);
  });

  it("treats a wildcard entry as a literal that matches nothing real", () => {
    expect(hostApproved(["*.todoist.com"], "api.todoist.com")).toBe(false);
  });

  it("approves nothing when the list is empty, because empty is the starting state", () => {
    expect(hostApproved([], "api.todoist.com")).toBe(false);
  });
});

describe("secure transport", () => {
  it("accepts https on the default port only", () => {
    expect(isSecureTransport(new URL("https://api.todoist.com/rest"))).toBe(true);
    expect(isSecureTransport(new URL("https://api.todoist.com:443/rest"))).toBe(true);
  });

  it("refuses plain http and a non-default port", () => {
    expect(isSecureTransport(new URL("http://api.todoist.com/rest"))).toBe(false);
    expect(isSecureTransport(new URL("https://api.todoist.com:8443/rest"))).toBe(false);
  });
});

describe("the test-only exemption", () => {
  it("exempts exactly the configured hosts", () => {
    expect(exemptFromSecureTransport("127.0.0.1, localhost", "127.0.0.1")).toBe(true);
    expect(exemptFromSecureTransport("127.0.0.1", "127.0.0.2")).toBe(false);
  });

  it("exempts nothing when the configuration is empty, which is production's shape", () => {
    expect(exemptFromSecureTransport("", "127.0.0.1")).toBe(false);
  });
});

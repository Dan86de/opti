/**
 * The placeholder protocol is textual on purpose: a placeholder assembled by
 * string concatenation inside the sandbox must scan the same as one typed
 * whole, because the scan runs over the final serialized request and not
 * over anybody's source code.
 */
import { describe, expect, it } from "vitest";
import { scan, substitute } from "../../src/gateway/Placeholder.ts";

describe("scanning", () => {
  it("finds names across url, headers and body uniformly", () => {
    const names = scan([
      "https://api.example/items?key={{credential:query-key}}",
      "Bearer {{credential:todoist}}",
      '{"token":"{{credential:body.token}}"}',
    ]);

    expect([...names].sort()).toStrictEqual(["body.token", "query-key", "todoist"]);
  });

  it("reports a name once however many times it appears", () => {
    expect(scan(["{{credential:todoist}} and {{credential:todoist}}"])).toStrictEqual(["todoist"]);
  });

  it("treats anything outside [a-z0-9._-] as literal text, not a name", () => {
    // Uppercase, spaces and braces do not name a credential. What must not
    // have happened: no name was extracted, so nothing will be resolved and
    // the literal text travels as the sandbox wrote it.
    expect(scan(["{{credential:TODOIST}}", "{{credential:a b}}", "{{credential:}}", "{credential:x}"])).toStrictEqual(
      [],
    );
  });
});

describe("substitution", () => {
  it("replaces every occurrence of every resolved name", () => {
    const values = new Map([
      ["todoist", "tok-123"],
      ["other", "tok-456"],
    ]);

    expect(substitute("Bearer {{credential:todoist}} + {{credential:other}} + {{credential:todoist}}", values)).toBe(
      "Bearer tok-123 + tok-456 + tok-123",
    );
  });

  it("leaves a placeholder whose name is not in the map untouched", () => {
    expect(substitute("{{credential:unknown}}", new Map())).toBe("{{credential:unknown}}");
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { safeEq, accessLevel, opType, hasMutation, BLOCKED_MUTATIONS } from "../lib/guards.js";

const store = { readSecret: "read-key", writeSecret: "write-key" };

test("accessLevel: write key resolves to write", () => assert.equal(accessLevel(store, "write-key"), "write"));
test("accessLevel: read key resolves to read", () => assert.equal(accessLevel(store, "read-key"), "read"));
test("accessLevel: wrong or empty key resolves to null", () => {
  assert.equal(accessLevel(store, "nope"), null);
  assert.equal(accessLevel(store, ""), null);
});
test("accessLevel: store with only a read secret never grants write", () =>
  assert.equal(accessLevel({ readSecret: "r" }, "r"), "read"));
test("accessLevel: legacy single key that is both secrets resolves to write", () =>
  assert.equal(accessLevel({ readSecret: "k", writeSecret: "k" }, "k"), "write"));

test("safeEq: equal and unequal strings", () => {
  assert.equal(safeEq("abc", "abc"), true);
  assert.equal(safeEq("abc", "abd"), false);
  assert.equal(safeEq("abc", "abcd"), false);
});

test("opType: anonymous, query, mutation, subscription", () => {
  assert.equal(opType("{ shop { name } }"), "query");
  assert.equal(opType("query Q { shop { name } }"), "query");
  assert.equal(opType("mutation M { productUpdate { userErrors { message } } }"), "mutation");
  assert.equal(opType("subscription S { x }"), "subscription");
});
test("opType: leading comments and docstrings are ignored", () => {
  assert.equal(opType("# hi\nmutation M { x }"), "mutation");
  assert.equal(opType('"""doc"""\nquery { shop { name } }'), "query");
});
test("opType: garbage returns null", () => assert.equal(opType("hello"), null));

test("hasMutation: detects a mutation keyword after a query", () => {
  assert.equal(hasMutation("query { a } mutation { b }"), true);
  assert.equal(hasMutation("query { shop { name } }"), false);
  assert.equal(hasMutation("# mutation in a comment\nquery { a }"), false);
});

test("BLOCKED_MUTATIONS (current behavior, replaced in T2): whole-word, case-sensitive", () => {
  assert.ok(BLOCKED_MUTATIONS.test("mutation { orderCancel(orderId: \"1\") { job { id } } }"));
  assert.ok(!BLOCKED_MUTATIONS.test("mutation { productUpdate { product { id } } }"));
  assert.ok(!BLOCKED_MUTATIONS.test("mutation { orderCancelled { x } }"));
  assert.ok(!BLOCKED_MUTATIONS.test("mutation { ORDERCANCEL { x } }"));
});

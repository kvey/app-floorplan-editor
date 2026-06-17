// Phase 2 (§5.1): pure ft-in parser/formatter used by the NumField component.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeet, clamp, formatFeet, formatField } from "../src/ui/ftparse.ts";

test("parseFeet: feet + inches forms", () => {
  assert.equal(parseFeet("3'6\""), 3.5);
  assert.equal(parseFeet("3' 6\""), 3.5);
  assert.equal(parseFeet("3'"), 3);
  assert.equal(parseFeet("42\""), 3.5);
});

test("parseFeet: plain decimals", () => {
  assert.equal(parseFeet("3.25"), 3.25);
  assert.equal(parseFeet("3.5"), 3.5);
  assert.equal(parseFeet("8"), 8);
});

test("parseFeet: unicode primes", () => {
  assert.equal(parseFeet("3′6″"), 3.5);
});

test("parseFeet: junk → null", () => {
  assert.equal(parseFeet(""), null);
  assert.equal(parseFeet("   "), null);
  assert.equal(parseFeet("abc"), null);
  assert.equal(parseFeet("3 ft"), null);
});

test("clamp respects min/max", () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(-2, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});

test("formatFeet rounds to nearest inch", () => {
  assert.equal(formatFeet(3.5), "3' 6\"");
  assert.equal(formatFeet(3), "3' 0\"");
  assert.equal(formatFeet(0.5), "0' 6\"");
  // 2.999... rounds up to a clean 3' 0"
  assert.equal(formatFeet(2.9999), "3' 0\"");
});

test("formatField: feet show ft-in; degrees/unitless plain", () => {
  assert.equal(formatField(3.5, "ft"), "3' 6\"");
  assert.equal(formatField(70, "°"), "70°");
  assert.equal(formatField(6, ""), "6");
});

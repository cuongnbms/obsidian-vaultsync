// SPDX-License-Identifier: MIT
//
// The automatic check slows down while nothing happens and speeds up the moment
// something does.
import test from "node:test";
import assert from "node:assert/strict";
import { IdleBackoff } from "./_backoff.mjs";

test("each pass that moved nothing doubles the wait, up to the cap", () => {
	const b = new IdleBackoff(15_000, 300_000);
	const seen = [b.delay];
	for (let i = 0; i < 7; i++) {
		b.idle();
		seen.push(b.delay);
	}
	assert.deepEqual(seen, [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
});

test("anything happening brings the wait back to the base", () => {
	const b = new IdleBackoff(15_000, 300_000);
	b.idle();
	b.idle();
	assert.equal(b.backedOff, true);
	b.active();
	assert.equal(b.delay, 15_000);
	assert.equal(b.backedOff, false);
});

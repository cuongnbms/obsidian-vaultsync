// SPDX-License-Identifier: MIT
//
// The automatic check slows down while nothing happens and speeds up the moment
// something does.
import test from "node:test";
import assert from "node:assert/strict";
import { IdleBackoff } from "./_backoff.mjs";

const BASE = 15_000;
const MAX = 300_000;

test("each pass that moved nothing doubles the wait, up to the cap", () => {
	const b = new IdleBackoff(BASE, MAX);
	const seen = [b.delay];
	for (let i = 0; i < 7; i++) {
		b.finished(false, i);
		seen.push(b.delay);
	}
	assert.deepEqual(seen, [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
});

test("a pass that moved something, or an edit here, brings the wait back to the base", () => {
	const b = new IdleBackoff(BASE, MAX);
	b.finished(false, 0);
	b.finished(false, 0);
	b.finished(true, 0);
	assert.equal(b.delay, BASE);
	b.finished(false, 0);
	b.active();
	assert.equal(b.delay, BASE);
});

test("coming back to the app after a quiet spell checks at once", () => {
	const b = new IdleBackoff(BASE, MAX);
	b.finished(false, 0);
	b.finished(false, 0);
	assert.equal(b.wake(BASE * 4), true);
	assert.equal(b.delay, BASE);
});

test("switching windows right after a pass starts no pass of its own", () => {
	const b = new IdleBackoff(BASE, MAX);
	b.finished(false, 0);
	b.finished(false, 0);
	// The blur that left the window flushed; the focus that follows a few
	// seconds later has nothing new to ask.
	b.finished(false, 100_000);
	assert.equal(b.wake(100_000 + 5_000), false);
	assert.equal(b.delay, 120_000);
});

test("while checks are at the base pace, focus triggers nothing extra", () => {
	const b = new IdleBackoff(BASE, MAX);
	assert.equal(b.wake(1_000_000), false);
});

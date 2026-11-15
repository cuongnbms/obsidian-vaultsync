// SPDX-License-Identifier: MIT
//
// A device catching up on a vault of thousands of notes used to fetch them one
// request at a time, so its first sync took as many round trips as there were
// notes. New notes now arrive several at once; everything that touches what is
// already on disk still goes one at a time, in order.

import test from "node:test";
import assert from "node:assert/strict";
import { startServer, makeDevice } from "./harness/device.mjs";
import { VaultCipher } from "./_crypto.mjs";

/** How many downloads a pull keeps in flight. A literal, not read from the engine. */
const IN_FLIGHT = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wraps getFile so a test can see how many downloads overlap, and hold one open. */
function watchedDownloads() {
	const state = { inFlight: 0, peak: 0, paths: [], hold: null, gate: null };
	return {
		state,
		wrapClient(c) {
			const getFile = c.getFile.bind(c);
			c.getFile = async (path, rev) => {
				state.inFlight++;
				state.peak = Math.max(state.peak, state.inFlight);
				state.paths.push(path);
				try {
					if (state.gate) await state.gate;
					else if (state.hold && state.hold.path === path) await state.hold.released;
					else await sleep(20);
					return await getFile(path, rev);
				} finally {
					state.inFlight--;
				}
			};
			return c;
		},
	};
}

async function writerAndCatchingUp(watch, options = {}) {
	const server = await startServer();
	const a = await makeDevice(server, "mac", server.tokens.a, options);
	const b = await makeDevice(server, "iphone", server.tokens.b, { ...options, wrapClient: watch.wrapClient });
	return {
		a,
		b,
		async cleanup() {
			await a.cleanup();
			await b.cleanup();
			await server.stop();
		},
	};
}

const noteName = (i) => `Notes/${String(i).padStart(2, "0")}.md`;

test("a device catching up downloads new notes several at once, never more than the limit", async (t) => {
	const watch = watchedDownloads();
	const { a, b, cleanup } = await writerAndCatchingUp(watch);
	t.after(cleanup);

	for (let i = 0; i < 20; i++) await a.edit(noteName(i), `note ${i}\n`);
	assert.deepEqual((await a.sync()).errors, []);

	const report = await b.sync();
	assert.deepEqual(report.errors, []);
	assert.equal(report.downloaded, 20);
	for (let i = 0; i < 20; i++) assert.equal(await b.vault.read(noteName(i)), `note ${i}\n`);
	assert.equal(watch.state.peak, IN_FLIGHT);

	// Nothing that arrived is mistaken for a file made here and sent back.
	assert.equal(report.uploaded, 0);
	const again = await b.sync();
	assert.equal(again.uploaded + again.downloaded + again.merged + again.conflicts, 0);
	const back = await a.sync();
	assert.equal(back.uploaded + back.downloaded + back.merged + back.conflicts, 0);
});

test("notes landing together in a folder that does not exist yet all arrive, even where mkdir refuses an existing folder", async (t) => {
	const watch = watchedDownloads();
	const { a, b, cleanup } = await writerAndCatchingUp(watch);
	t.after(cleanup);

	// Some adapters throw when asked to make a folder that is already there. Two
	// downloads into one new folder both find it missing and both ask to make it.
	// The first call is still making the folder when the others arrive.
	const mkdir = b.vault.adapter.mkdir;
	const made = new Set();
	b.vault.adapter.mkdir = async (p) => {
		if (made.has(p) || (await b.vault.adapter.exists(p))) throw new Error(`folder already exists: ${p}`);
		made.add(p);
		await sleep(10);
		return mkdir(p);
	};

	for (let i = 0; i < 4; i++) await a.edit(`Trips/Armenia/${i}.md`, `day ${i}\n`);
	assert.deepEqual((await a.sync()).errors, []);

	const report = await b.sync();
	assert.deepEqual(report.errors, []);
	for (let i = 0; i < 4; i++) assert.equal(await b.vault.read(`Trips/Armenia/${i}.md`), `day ${i}\n`);
});

async function until(condition, what) {
	for (let i = 0; i < 200; i++) {
		if (await condition()) return;
		await sleep(10);
	}
	throw new Error(`timed out waiting for ${what}`);
}

test("the cursor does not move past a download still in flight", async (t) => {
	const watch = watchedDownloads();
	const { a, b, cleanup } = await writerAndCatchingUp(watch);
	t.after(cleanup);

	for (let i = 0; i < 20; i++) await a.edit(noteName(i), `note ${i}\n`);
	assert.deepEqual((await a.sync()).errors, []);

	// The first note in the log hangs while the other nineteen land. A checkpoint
	// taken now saves this cursor, and a kill must find the first note still ahead.
	let release;
	watch.state.hold = { path: noteName(0), released: new Promise((r) => (release = r)) };
	const pass = b.sync();
	await until(async () => {
		for (let i = 1; i < 20; i++) if (!(await b.vault.adapter.exists(noteName(i)))) return false;
		return true;
	}, "the other nineteen notes");
	assert.equal(watch.state.inFlight, 1);
	assert.equal(b.index.lastSeq, 0);

	release();
	assert.deepEqual((await pass).errors, []);
	assert.equal(await b.vault.read(noteName(0)), "note 0\n");
	assert.ok(b.index.lastSeq > 0);
});

test("a pass stopped in the middle of a run leaves the cursor before the files it never started", async (t) => {
	const watch = watchedDownloads();
	const { a, b, cleanup } = await writerAndCatchingUp(watch);
	t.after(cleanup);

	for (let i = 0; i < 20; i++) await a.edit(noteName(i), `note ${i}\n`);
	assert.deepEqual((await a.sync()).errors, []);

	// Every download hangs, so eight are in flight and twelve not yet started when
	// the plugin is unloaded.
	let release;
	watch.state.gate = new Promise((r) => (release = r));
	const pass = b.sync();
	await until(() => watch.state.inFlight === 8, "eight downloads in flight");
	b.stop();
	release();
	await pass;
	assert.equal(watch.state.paths.length, 8);
	assert.equal(b.index.lastSeq, 0);

	b.resume();
	assert.deepEqual((await b.sync()).errors, []);
	for (let i = 0; i < 20; i++) assert.equal(await b.vault.read(noteName(i)), `note ${i}\n`);
	assert.ok(b.index.lastSeq > 0);
});

test("an encrypted vault with hidden names arrives whole when fetched several at once", async (t) => {
	const { cipher } = await VaultCipher.create("shared passphrase", { iterations: 1, memory_kib: 64 });
	const watch = watchedDownloads();
	const { a, b, cleanup } = await writerAndCatchingUp(watch, { cipher, pathCipher: await cipher.pathCipher() });
	t.after(cleanup);

	for (let i = 0; i < 20; i++) await a.edit(noteName(i), `secret ${i}\n`);
	assert.deepEqual((await a.sync()).errors, []);

	const report = await b.sync();
	assert.deepEqual(report.errors, []);
	assert.equal(report.downloaded, 20);
	for (let i = 0; i < 20; i++) assert.equal(await b.vault.read(noteName(i)), `secret ${i}\n`);
	assert.equal(watch.state.peak, IN_FLIGHT);
	assert.equal(report.uploaded, 0);
	const again = await b.sync();
	assert.equal(again.uploaded + again.downloaded + again.merged + again.conflicts, 0);
});

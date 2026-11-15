// SPDX-License-Identifier: MIT
//
// The index checkpoint, against an adapter slow enough that saves overlap.
import test from "node:test";
import assert from "node:assert/strict";
import { LocalIndex } from "./_index-store.mjs";

/** An in-memory adapter whose writes take a while, and can be told to fail. */
function slowAdapter(ms = 30) {
	const files = new Map();
	const adapter = {
		files,
		failWrites: false,
		async exists(p) {
			return files.has(p);
		},
		async read(p) {
			return files.get(p);
		},
		async write(p, body) {
			await new Promise((r) => setTimeout(r, ms));
			if (adapter.failWrites) throw new Error("disk full");
			files.set(p, body);
		},
	};
	return adapter;
}

const entry = { base_rev: 1, base_hash: "h", local_hash: "h", mtime: 0 };

function savedPaths(adapter) {
	return Object.keys(JSON.parse(adapter.files.get(".index/index.json")).files);
}

test("a save asked for while another runs has written this caller's changes when it resolves", async () => {
	const adapter = slowAdapter();
	const index = new LocalIndex(adapter, ".index");

	index.set("one.md", entry);
	const first = index.save();
	index.set("two.md", entry);
	const second = index.save();

	await first;
	await second;
	// The second caller used to get the first save's promise, which wrote before
	// two.md existed; its own changes reached the disk later, unawaited.
	assert.deepEqual(savedPaths(adapter).sort(), ["one.md", "two.md"]);
});

test("callers who ask during one save share the next write", async () => {
	const adapter = slowAdapter();
	let writes = 0;
	const write = adapter.write;
	adapter.write = async (p, body) => {
		if (p.endsWith("index.json")) writes++;
		return write(p, body);
	};
	const index = new LocalIndex(adapter, ".index");

	const saves = [index.save()];
	for (const name of ["a.md", "b.md", "c.md"]) {
		index.set(name, entry);
		saves.push(index.save());
	}
	await Promise.all(saves);

	assert.equal(writes, 2);
	assert.deepEqual(savedPaths(adapter).sort(), ["a.md", "b.md", "c.md"]);
});

test("a save that fails rejects for the caller whose changes it was writing", async () => {
	const adapter = slowAdapter();
	const index = new LocalIndex(adapter, ".index");

	const first = index.save();
	index.set("two.md", entry);
	const second = index.save();
	await first;
	adapter.failWrites = true;

	await assert.rejects(second, /disk full/);
});

/** Counts every adapter call that touches the disk. */
function counting(adapter) {
	const calls = { read: 0, write: 0 };
	const { read, write } = adapter;
	adapter.read = async (p) => {
		calls.read++;
		return read(p);
	};
	adapter.write = async (p, body) => {
		calls.write++;
		return write(p, body);
	};
	return calls;
}

// An idle pass every few seconds ends with a save. Rewriting an unchanged index,
// and its backup copy, cost a multi-megabyte write per pass on a large vault.
test("a save with nothing changed since the last write leaves the disk alone", async () => {
	const adapter = slowAdapter(1);
	const index = new LocalIndex(adapter, ".index");
	index.set("one.md", entry);
	await index.save();

	const calls = counting(adapter);
	await index.save();
	await index.save();
	assert.deepEqual(calls, { read: 0, write: 0 });
});

test("a change made through a reference the index handed out is still saved", async () => {
	const adapter = slowAdapter(1);
	const index = new LocalIndex(adapter, ".index");
	index.set("one.md", { ...entry });
	await index.save();

	index.get("one.md").base_rev = 7;
	index.renames.push({ from: "a.md", to: "b.md", base_rev: 1 });
	await index.save();

	const saved = JSON.parse(adapter.files.get(".index/index.json"));
	assert.equal(saved.files["one.md"].base_rev, 7);
	assert.equal(saved.renames.length, 1);
});

test("a save that failed is tried again by the next one", async () => {
	const adapter = slowAdapter(1);
	const index = new LocalIndex(adapter, ".index");
	index.set("one.md", entry);
	adapter.failWrites = true;
	await assert.rejects(index.save(), /disk full/);

	adapter.failWrites = false;
	await index.save();
	assert.deepEqual(savedPaths(adapter), ["one.md"]);
});

test("an index just loaded is not written back as it was", async () => {
	const adapter = slowAdapter(1);
	const first = new LocalIndex(adapter, ".index");
	first.set("one.md", entry);
	await first.save();

	const index = new LocalIndex(adapter, ".index");
	await index.load();
	const calls = counting(adapter);
	await index.save();
	assert.equal(calls.write, 0);
});

test("an index loaded from its backup copy rewrites the main file on the first save", async () => {
	const adapter = slowAdapter(1);
	const first = new LocalIndex(adapter, ".index");
	first.set("one.md", entry);
	await first.save();
	adapter.files.set(".index/index.prev.json", adapter.files.get(".index/index.json"));
	adapter.files.set(".index/index.json", "{torn");

	const index = new LocalIndex(adapter, ".index");
	await index.load();
	await index.save();
	assert.deepEqual(savedPaths(adapter), ["one.md"]);
});

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

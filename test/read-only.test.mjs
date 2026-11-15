// A read-only device takes from the server and gives nothing back. Two devices,
// one real server, the real engine: "mac" writes, "iphone" only reads.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer, makeDevice } from "./harness/device.mjs";
import { SyncClient, ReadOnlyError } from "./_sync-engine.mjs";

async function writerAndReader(readerOptions = {}) {
	const server = await startServer();
	const a = await makeDevice(server, "mac", server.tokens.a);
	const b = await makeDevice(server, "iphone", server.tokens.b, { readOnly: true, ...readerOptions });
	return {
		server,
		a,
		b,
		/** Every path the server's log has ever seen, live or deleted. */
		async serverPaths() {
			const raw = await server.rawChanges(server.tokens.a);
			return raw.entries.map((e) => `${e.path}@${e.rev}${e.deleted ? " deleted" : ""}`).sort();
		},
		async cleanup() {
			await a.cleanup();
			await b.cleanup();
			await server.stop();
		},
	};
}

test("a read-only client refuses every write before it reaches the server", async (t) => {
	const server = await startServer();
	t.after(() => server.stop());
	const client = new SyncClient(server.url, server.tokens.b, "iphone", null, true);

	const body = new TextEncoder().encode("x\n").buffer;
	await assert.rejects(client.putFile("a.md", 0, body, Date.now()), ReadOnlyError);
	await assert.rejects(client.putFolder("dir", 0), ReadOnlyError);
	await assert.rejects(client.deleteFile("a.md", 1), ReadOnlyError);
	await assert.rejects(client.rename("a.md", "b.md", 1), ReadOnlyError);
	await assert.rejects(client.setRetention(5), ReadOnlyError);
	await assert.rejects(client.purgeDeleted(), ReadOnlyError);
	await assert.rejects(client.setMigration(), ReadOnlyError);

	const raw = await server.rawChanges(server.tokens.a);
	assert.deepEqual(raw.entries, []);
	assert.equal(await client.getRetention(), 30, "reads still work");
	const join = await client.createJoin("ipad");
	assert.ok(join.code, "linking a new device is not a vault write and stays allowed");
});

test("an edit on a read-only device goes back to the server's version, kept aside here", async (t) => {
	const { a, b, serverPaths, cleanup } = await writerAndReader();
	t.after(cleanup);

	await a.edit("note.md", "from the mac\n");
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.read("note.md"), "from the mac\n");

	await b.edit("note.md", "typed on the phone\n");
	const report = await b.sync();

	assert.deepEqual(report.errors, []);
	assert.equal(await b.vault.read("note.md"), "from the mac\n");
	const copies = Object.keys(await b.vault.snapshot()).filter((p) => p.startsWith("note (iphone"));
	assert.equal(copies.length, 1, "the phone's text is kept in one copy");
	assert.equal(await b.vault.read(copies[0]), "typed on the phone\n");
	assert.deepEqual(await serverPaths(), ["note.md@1"]);
	assert.deepEqual(b.engine.filesOnlyHere(), [], "a copy kept aside is not offered for upload");

	// Nothing left over: the next pass has nothing to do.
	const again = await b.sync();
	assert.deepEqual([again.downloaded, again.uploaded, again.errors], [0, 0, []]);
	assert.deepEqual(await serverPaths(), ["note.md@1"]);
});

test("a file deleted on a read-only device comes back at the server's latest version", async (t) => {
	const { a, b, serverPaths, cleanup } = await writerAndReader();
	t.after(cleanup);

	await a.edit("note.md", "one\n");
	await a.sync();
	await b.sync();

	await b.delete("note.md");
	await a.edit("note.md", "two\n");
	await a.sync();
	const report = await b.sync();

	assert.deepEqual(report.errors, []);
	assert.equal(await b.vault.read("note.md"), "two\n");
	assert.deepEqual(await serverPaths(), ["note.md@2"]);
});

test("when both sides edited, a read-only device takes the server's text without asking", async (t) => {
	const { a, b, serverPaths, cleanup } = await writerAndReader();
	t.after(cleanup);

	await a.edit("note.md", "one\ntwo\nthree\n");
	await a.sync();
	await b.sync();

	await a.edit("note.md", "ONE\ntwo\nthree\n");
	await b.edit("note.md", "one\ntwo\nTHREE\n");
	await a.sync();
	const report = await b.sync();

	assert.deepEqual(report.errors, []);
	assert.deepEqual(b.conflicts, [], "nothing to decide on a device that cannot send a decision");
	assert.equal(await b.vault.read("note.md"), "ONE\ntwo\nthree\n", "the server's text, not a merge");
	const copies = Object.keys(await b.vault.snapshot()).filter((p) => p.startsWith("note (iphone"));
	assert.equal(copies.length, 1);
	assert.equal(await b.vault.read(copies[0]), "one\ntwo\nTHREE\n");
	assert.deepEqual(await serverPaths(), ["note.md@2"]);
});

test("a deletion from the server applies on a read-only device, its edit kept aside", async (t) => {
	const { a, b, serverPaths, cleanup } = await writerAndReader();
	t.after(cleanup);

	await a.edit("note.md", "one\n");
	await a.sync();
	await b.sync();

	await b.edit("note.md", "typed on the phone\n");
	await a.delete("note.md");
	await a.sync();
	const report = await b.sync();

	assert.deepEqual(report.errors, []);
	const files = Object.keys(await b.vault.snapshot()).filter((p) => !p.startsWith(".index/"));
	assert.equal(files.length, 1, `only the copy is left: ${files}`);
	assert.match(files[0], /^note \(iphone/);
	assert.equal(await b.vault.read(files[0]), "typed on the phone\n");
	assert.deepEqual(await serverPaths(), ["note.md@2 deleted"]);
});

test("a rename on a read-only device is moved back, and the server never hears of it", async (t) => {
	const { a, b, serverPaths, cleanup } = await writerAndReader();
	t.after(cleanup);

	await a.edit("Notes/note.md", "one\n");
	await a.sync();
	await b.sync();

	await b.rename("Notes/note.md", "Elsewhere/renamed.md");
	const report = await b.sync();

	assert.deepEqual(report.errors, []);
	const files = Object.keys(await b.vault.snapshot()).filter((p) => !p.startsWith(".index/"));
	assert.deepEqual(files, ["Notes/note.md"]);
	assert.equal(await b.vault.read("Notes/note.md"), "one\n");
	assert.deepEqual(b.index.renames, []);
	assert.deepEqual(await serverPaths(), ["Notes/note.md@1"]);
});

test("files made on a read-only device stay there, and are offered when the mode is turned off", async (t) => {
	const { a, b, serverPaths, cleanup } = await writerAndReader();
	t.after(cleanup);

	await a.edit("note.md", "one\n");
	await a.sync();
	await b.sync();

	await b.edit("Daily/2026-11-14.md", "made by a plugin\n");
	await b.vault.write("untracked.md", "written by another app\n");
	const report = await b.sync();

	assert.deepEqual(report.errors, []);
	assert.deepEqual(await serverPaths(), ["note.md@1"]);
	assert.deepEqual(b.engine.filesOnlyHere(), ["Daily/2026-11-14.md", "untracked.md"]);

	await b.engine.switchReadOnly(false, ["untracked.md"]);
	assert.equal(b.settings.readOnly, false);
	await b.sync();

	assert.deepEqual(await serverPaths(), ["Daily/2026-11-14.md@1", "note.md@1"]);
	assert.deepEqual(b.engine.filesOnlyHere(), []);
	assert.equal(await b.vault.read("untracked.md"), "written by another app\n");
});

test("turning read-only on counts the changes here that were never sent", async (t) => {
	const { a, b, cleanup } = await writerAndReader();
	t.after(cleanup);
	b.settings.readOnly = false;

	await a.edit("one.md", "1\n");
	await a.edit("two.md", "2\n");
	await a.edit("three.md", "3\n");
	await a.sync();
	await b.sync();
	assert.equal(b.engine.pendingChanges(), 0);

	await b.edit("one.md", "edited\n");
	await b.delete("two.md");
	await b.rename("three.md", "moved.md");
	await b.edit("new.md", "new\n");
	// An edit, a deletion and a move would be undone; a new file is not lost.
	assert.equal(b.engine.pendingChanges(), 3);

	await b.engine.switchReadOnly(true);
	assert.equal(b.settings.readOnly, true);
});

/** A client whose next `failures` downloads fail, as on a phone losing signal. */
function flakyDownloads() {
	const state = { failures: 0 };
	return {
		state,
		wrapClient(c) {
			const getFile = c.getFile.bind(c);
			c.getFile = async (...args) => {
				if (state.failures > 0) {
					state.failures--;
					throw new Error("network down");
				}
				return getFile(...args);
			};
			return c;
		},
	};
}

async function copiesOf(device, stem) {
	return Object.keys(await device.vault.snapshot()).filter((p) => p.startsWith(`${stem} (iphone`));
}

test("putting a file back that fails to download keeps one copy, not one per attempt", async (t) => {
	const flaky = flakyDownloads();
	const { a, b, cleanup } = await writerAndReader({ wrapClient: flaky.wrapClient });
	t.after(cleanup);

	await a.edit("note.md", "from the mac\n");
	await a.sync();
	await b.sync();

	await b.edit("note.md", "typed on the phone\n");
	flaky.state.failures = 2;
	assert.equal((await b.sync()).errors.length, 1);
	assert.equal((await b.sync()).errors.length, 1);
	assert.deepEqual((await b.sync()).errors, []);

	assert.equal(await b.vault.read("note.md"), "from the mac\n");
	const copies = await copiesOf(b, "note");
	assert.equal(copies.length, 1, `one copy, got ${copies}`);
	assert.equal(await b.vault.read(copies[0]), "typed on the phone\n");
});

test("a server change that fails to download onto an edit here keeps one copy, not one per attempt", async (t) => {
	const flaky = flakyDownloads();
	const { a, b, cleanup } = await writerAndReader({ wrapClient: flaky.wrapClient });
	t.after(cleanup);

	await a.edit("note.md", "one\n");
	await a.sync();
	await b.sync();

	await a.edit("note.md", "two\n");
	await a.sync();
	await b.edit("note.md", "typed on the phone\n");
	flaky.state.failures = 1;
	assert.equal((await b.sync()).errors.length, 1);
	assert.deepEqual((await b.sync()).errors, []);

	assert.equal(await b.vault.read("note.md"), "two\n");
	const copies = await copiesOf(b, "note");
	assert.equal(copies.length, 1, `one copy, got ${copies}`);
	assert.equal(await b.vault.read(copies[0]), "typed on the phone\n");
});

test("most of a read-only vault gone while closed simply comes back, with nothing held", async (t) => {
	const { a, b, serverPaths, cleanup } = await writerAndReader();
	t.after(cleanup);

	const names = Array.from({ length: 12 }, (_, i) => `n${String(i).padStart(2, "0")}.md`);
	for (const name of names) await a.edit(name, `${name}\n`);
	await a.sync();
	await b.sync();

	// Gone while Obsidian was closed: no watcher saw it.
	for (const name of names) await b.vault.remove(name);
	b.restart();
	const report = await b.sync();

	assert.deepEqual(report.errors, []);
	for (const name of names) assert.equal(await b.vault.read(name), `${name}\n`);
	assert.equal((await serverPaths()).length, 12);
});

test("an edit kept against a deletion, then the device made read-only, takes the deletion", async (t) => {
	let failPuts = false;
	const { a, b, serverPaths, cleanup } = await writerAndReader({
		wrapClient(c) {
			const putFile = c.putFile.bind(c);
			c.putFile = async (...args) => {
				if (failPuts) throw new Error("network down");
				return putFile(...args);
			};
			return c;
		},
	});
	t.after(cleanup);
	b.settings.readOnly = false;

	await a.edit("note.md", "one\n");
	await a.sync();
	await b.sync();

	await a.delete("note.md");
	await a.sync();
	await b.edit("note.md", "typed on the phone\n");
	// The edit resists the deletion, and cannot be sent.
	failPuts = true;
	await b.sync();
	failPuts = false;

	await b.engine.switchReadOnly(true);
	assert.deepEqual((await b.sync()).errors, []);
	assert.deepEqual((await b.sync()).errors, []);

	assert.equal(await b.vault.exists("note.md"), false);
	const copies = await copiesOf(b, "note");
	assert.equal(copies.length, 1, `one copy, got ${copies}`);
	assert.equal(await b.vault.read(copies[0]), "typed on the phone\n");
	assert.deepEqual(await serverPaths(), ["note.md@2 deleted"]);
});

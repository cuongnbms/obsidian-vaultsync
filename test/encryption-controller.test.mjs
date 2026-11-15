// SPDX-License-Identifier: MIT
//
// The decisions that keep plaintext off an encrypted vault: when the key is
// opened, when it is created, and when a pass is refused. The server is a fake
// that answers the three questions the controller asks it.
import test from "node:test";
import assert from "node:assert/strict";
import { EncryptionController } from "./_encryption-controller.mjs";
import { VaultCipher } from "./_crypto.mjs";

const cheap = { iterations: 1, memory_kib: 64 };

/** A vault key record, as the server would hold it. */
async function keyRecord(passphrase, extra = {}) {
	const { params } = await VaultCipher.create(passphrase, cheap);
	return { ...params, ...extra };
}

/**
 * A controller around a fake server. The client port behaves like the plugin's:
 * no client while the vault hides names and the path key is not ready.
 */
function setup({ passphrase = "", key = null, stats = { files: 0, folders: 0 }, excluded = [], localFiles = 0 } = {}) {
	const server = {
		key,
		answer: stats,
		fail: null,
		asked: 0,
		created: [],
		async getVaultKey() {
			server.asked++;
			if (server.fail) throw server.fail;
			return server.key;
		},
		async putVaultKey(params) {
			server.created.push(params);
			server.key = params;
		},
		async stats() {
			return server.answer;
		},
	};
	const settings = { serverUrl: "http://server", token: "obs_t", deviceName: "mac", passphrase, readOnly: false };
	const said = { notices: [], statuses: [], syncs: 0, encrypts: 0 };
	const controller = new EncryptionController({
		settings: () => settings,
		client: () => (controller.pathKeyMissing() ? null : server),
		plainClient: () => server,
		notice: (text) => said.notices.push(text),
		setStatus: (text) => said.statuses.push(text),
		syncNow: async () => {
			said.syncs++;
		},
		encryptInPlace: async () => {
			said.encrypts++;
		},
		excludedOnServer: async () => excluded,
		localFileCount: () => localFiles,
		serverIsEmpty: async () => Number(server.answer.files ?? 0) === 0,
	});
	return { controller, server, settings, said };
}

function assertClosed(controller) {
	assert.equal(controller.cipher.enabled, false, "a failure must never leave a cipher in use");
	assert.equal(controller.pathCipher, null);
	assert.equal(controller.isLocked(), true, "a failure must stop syncing, not fall back to plaintext");
}

test("the right passphrase opens the vault and its names, and starts a pass", async () => {
	const { controller, said } = setup({
		passphrase: "right",
		key: await keyRecord("right", { paths: "encrypted" }),
	});
	await controller.applyEncryption(false);

	assert.equal(controller.cipher.enabled, true);
	assert.notEqual(controller.pathCipher, null);
	assert.equal(controller.isLocked(), false);
	assert.match(controller.status, /file names are both hidden/);
	assert.equal(said.syncs, 1);
});

test("a wrong passphrase locks, is said once, and is not tried again", async () => {
	// Readable names, so that nothing but the settled outcome can stop the retry.
	const { controller, server, said } = setup({
		passphrase: "wrong",
		key: await keyRecord("right", { paths: "plain" }),
	});

	await assert.rejects(controller.applyEncryption(false), /wrong passphrase/);
	assertClosed(controller);
	assert.match(controller.status, /Wrong passphrase/);
	assert.equal(said.notices.length, 1);

	await controller.applyEncryption(false);
	assert.equal(server.asked, 1, "the outcome is known; the server is not asked again");
	assert.equal(said.notices.length, 1, "and nothing is said twice");
});

test("a server that cannot be reached locks without a word, and is tried again", async () => {
	const { controller, server, said } = setup({ passphrase: "right", key: await keyRecord("right") });
	server.fail = new Error("could not connect");

	await assert.rejects(controller.applyEncryption(false), /could not connect/);
	assertClosed(controller);
	assert.deepEqual(said.notices, [], "offline repeats every pass, so it is not announced");

	server.fail = null;
	await controller.applyEncryption(true);
	assert.equal(server.asked, 2);
	assert.equal(controller.cipher.enabled, true);
});

test("another device encrypting the vault keeps this one out", async () => {
	const { controller, said } = setup({
		passphrase: "right",
		key: await keyRecord("right", { migration: { device: "desktop", started: 1, mine: false } }),
	});
	await controller.applyEncryption(false);
	assertClosed(controller);
	assert.equal(controller.migrationElsewhere(), "desktop");
	assert.equal(said.syncs, 0);
});

test("this device's own interrupted encryption continues on its own", async () => {
	const { controller, said } = setup({
		passphrase: "right",
		key: await keyRecord("right", { paths: "encrypted", migration: { device: "mac", started: 1, mine: true } }),
	});
	await controller.applyEncryption(true);
	assert.equal(controller.migrationHere(), true);
	assert.equal(said.encrypts, 1);
	assert.equal(said.syncs, 0, "the re-upload comes first");
});

test("a passphrase with no key on the server creates nothing unless asked to", async () => {
	const { controller, server } = setup({ passphrase: "half typ" });
	await controller.applyEncryption(false);

	assert.deepEqual(server.created, [], "a key is never created from a blur or a retry");
	assertClosed(controller);
	assert.match(controller.status, /Press Set passphrase/);
	assert.equal(controller.vaultNeedsSetup(), true);
});

test("no key is created while this device excludes files on the server", async () => {
	const { controller, server } = setup({
		passphrase: "chosen",
		stats: { files: 3, folders: 0 },
		excluded: ["private/a.md"],
	});
	await controller.applyEncryption(false, true);

	assert.deepEqual(server.created, [], "a key cannot be taken back");
	assertClosed(controller);
	assert.match(controller.status, /private\/a\.md/);
});

test("Set passphrase on an empty vault creates a key that hides names", async () => {
	const { controller, server, said } = setup({ passphrase: "chosen" });
	await controller.applyEncryption(false, true);

	assert.equal(server.created.length, 1);
	assert.equal(server.created[0].paths, "encrypted");
	assert.equal(controller.cipher.enabled, true);
	assert.equal(controller.hidesNames(), true);
	assert.equal(said.syncs, 1);
});

test("two calls at once make one attempt", async () => {
	const { controller, server } = setup({ passphrase: "right", key: await keyRecord("right") });
	await Promise.all([controller.applyEncryption(true), controller.applyEncryption(false)]);
	assert.equal(server.asked, 1);
});

test("Set pressed while leaving the field is still asking the server creates the key", async () => {
	// A mouse press on the button blurs the field first: the blur's attempt, which
	// may not create a key, is in flight when the button's attempt arrives.
	const { controller, server, said } = setup({ passphrase: "chosen" });
	const blur = controller.applyEncryption();
	const press = controller.applyEncryption(false, true);
	await Promise.allSettled([blur, press]);

	assert.equal(server.created.length, 1, "the press must create the key, not take the blur's answer");
	assert.equal(controller.cipher.enabled, true);
	assert.equal(controller.isLocked(), false);
	assert.equal(said.syncs, 1);
});

test("Set pressed during an attempt that found the key opens it once, and creates nothing", async () => {
	const { controller, server } = setup({ passphrase: "right", key: await keyRecord("right") });
	await Promise.all([controller.applyEncryption(true), controller.applyEncryption(false, true)]);

	assert.equal(server.created.length, 0, "a vault that has a key never gets a second one");
	assert.equal(controller.cipher.enabled, true);
});

test("the guard refuses a pass when it has never heard whether the vault has a key", async () => {
	const { controller, server } = setup();
	server.fail = new Error("could not connect");
	assert.match(await controller.reasonNotToSync(), /./);
	assert.equal(controller.cipher.enabled, false);
});

test("the guard lets a pass through a hiccup once it has heard there is no key", async () => {
	const { controller, server } = setup();
	assert.equal(await controller.reasonNotToSync(), "");
	server.fail = new Error("could not connect");
	assert.equal(await controller.reasonNotToSync(), "");
});

test("the guard locks a device without a passphrase out of an encrypted vault, and says so once", async () => {
	const { controller, said } = setup({ key: await keyRecord("right", { paths: "plain" }) });
	const reason = await controller.reasonNotToSync();
	assert.match(reason, /encrypted/i);
	assert.equal(controller.isLocked(), true);

	// Leaving the passphrase field empty lifts the lock; the next pass finds the
	// key again, and does not announce it again.
	await controller.applyEncryption(false);
	assert.equal(controller.isLocked(), false);
	await controller.reasonNotToSync();
	assert.equal(controller.isLocked(), true);
	assert.equal(said.notices.length, 1);
});

test("the first upload of a vault into an empty server waits for Sync now", async () => {
	const { controller } = setup({ localFiles: 5 });
	assert.match(await controller.reasonNotToSync(false), /./, "not on its own");
	assert.equal(await controller.reasonNotToSync(true), "", "a press by hand is the decision");
});

// A device that has learned the vault hides names, and has no path key yet, could
// not build a client. Unlocking asked the server for the key through that client,
// so it gave up without a word, and only restarting Obsidian got the device in.
test("once another device has finished encrypting, this one joins without a restart", async () => {
	const { controller, server } = setup({
		passphrase: "right",
		key: await keyRecord("right", { migration: { device: "desktop", started: 1, mine: false } }),
	});
	await controller.applyEncryption(true);
	assertClosed(controller);
	assert.equal(controller.migrationElsewhere(), "desktop");

	delete server.key.migration;
	await controller.applyEncryption(true);
	assert.equal(controller.cipher.enabled, true, "not settled: the next attempt joins");
});


test("a device locked out of a vault that hides names opens once the passphrase is typed", async () => {
	const { controller, settings } = setup({ key: await keyRecord("right", { paths: "encrypted" }) });
	await controller.reasonNotToSync();
	assert.equal(controller.isLocked(), true);

	settings.passphrase = "right";
	await controller.applyEncryption(false);
	assert.equal(controller.cipher.enabled, true);
	assert.equal(controller.isLocked(), false);
});


test("a wrong passphrase on a vault that hides names can be corrected", async () => {
	const { controller, settings } = setup({
		passphrase: "wrong",
		key: await keyRecord("right", { paths: "encrypted" }),
	});
	await assert.rejects(controller.applyEncryption(false));

	settings.passphrase = "right";
	await controller.applyEncryption(false);
	assert.equal(controller.cipher.enabled, true);
	assert.equal(controller.isLocked(), false);
});

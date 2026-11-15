// SPDX-License-Identifier: MIT

import type { SyncClient } from "./api";
import {
	VaultCipher,
	WrongPassphrase,
	plaintext,
	type Cipher,
	type Migration,
	type PathCipher,
	type VaultKeyRecord,
} from "./crypto";
import { t } from "./i18n";
import type { SyncSettings } from "./settings";
import { listPaths, mayPassWithoutKeyAnswer } from "./sync-engine";

/** What the controller needs from the plugin around it. */
export interface EncryptionPorts {
	settings(): SyncSettings;
	/** A client for this vault, or null when it cannot be built yet. */
	client(complain: boolean): SyncClient | null;
	/** A client that sees names as the server stores them, without a path key. */
	plainClient(): SyncClient;
	notice(text: string, ms?: number): void;
	setStatus(text: string): void;
	syncNow(quiet: boolean): Promise<void>;
	encryptInPlace(quiet: boolean): Promise<void>;
	/** Files on the server under paths this device excludes. */
	excludedOnServer(plain: SyncClient): Promise<string[]>;
	localFileCount(): number;
	serverIsEmpty(client: SyncClient): Promise<boolean>;
}

/**
 * True when this looks like the server simply not being there.
 *
 * Worth separating from other failures: it is the one that repeats on every pass
 * until something changes in the world, and repeating it every minute buries
 * everything else the plugin has to say.
 */
export function isUnreachable(message: string): boolean {
	return /could not connect|failed to fetch|network|ERR_|ENOTFOUND|ECONNREFUSED|timed out/i.test(
		message,
	);
}

function bindingOf(settings: SyncSettings): string {
	return `${settings.serverUrl}\n${settings.token}`;
}

/**
 * Whether this device can read and write the vault on the server, and with which
 * keys: the passphrase in the settings against the key record on the server.
 *
 * Kept apart from the plugin so that the decisions that keep plaintext off an
 * encrypted vault can be tested without Obsidian.
 */
export class EncryptionController {
	private _cipher: Cipher = plaintext;
	private _pathCipher: PathCipher | null = null;
	private cipherStatus = "";
	/**
	 * Encryption is switched on but the key is not available.
	 *
	 * Syncing has to stop here rather than fall back to plaintext. Falling back would
	 * publish to the server exactly the notes this setting exists to hide, and it
	 * would do it quietly.
	 */
	private locked = false;
	/** Said once, not on every pass. */
	private announcedEncryptedVault = false;
	/** Whether the vault already has key parameters. Null until asked. */
	private vaultHasKey: boolean | null = null;
	/** Whether the vault stores files under sealed names, as its key record says. */
	private vaultHidesNames: boolean | null = null;
	/** The server and token the two answers above came from. */
	private binding: string;
	/** The migration marker last seen on the key record, while one is running. */
	private migration: Migration | null = null;
	/** In flight, so two callers do not both do it and both report it. */
	private unlocking: Promise<void> | null = null;
	/** Whether the attempt in flight may create the key, as only Set may. */
	private unlockingMayCreate = false;
	/** The passphrase whose outcome is already known and already announced. */
	private settledPassphrase: string | null = null;

	constructor(private ports: EncryptionPorts) {
		this.binding = bindingOf(ports.settings());
	}

	private get settings(): SyncSettings {
		return this.ports.settings();
	}

	/** The content cipher in force: plaintext unless the vault is open. */
	get cipher(): Cipher {
		return this._cipher;
	}

	/** The path key, when the vault hides names and is open. */
	get pathCipher(): PathCipher | null {
		return this._pathCipher;
	}

	/** What the status bar says about encryption, or empty. */
	get status(): string {
		return this.cipherStatus;
	}

	/**
	 * Settings were saved. Another server, or another vault on it: what the old one
	 * said about its key says nothing about this one. A stale "no key" would let the
	 * guard wave a pass through on the first hiccup.
	 */
	settingsSaved(): void {
		const binding = bindingOf(this.settings);
		if (binding !== this.binding) {
			this.binding = binding;
			this.vaultHasKey = null;
			this.vaultHidesNames = null;
		}
	}

	/** A new server or token: what was said about the old one may be said again. */
	rebound(): void {
		this.announcedEncryptedVault = false;
	}

	/** The server answered whether the vault has a key, outside a guard or unlock. */
	heardVaultHasKey(has: boolean): void {
		this.vaultHasKey = has;
	}

	/** encryptInPlace finished: the vault is sealed and the marker is gone. */
	migrationFinished(): void {
		this.migration = null;
		this.cipherStatus = t("encryption.readyWithPaths");
	}

	/**
	 * True when the vault stores sealed names and the path key is not ready, so no
	 * client may be built: one without the key would write real names to the server.
	 */
	pathKeyMissing(): boolean {
		return this.vaultHidesNames === true && !this._pathCipher;
	}

	encryptionStatus(): string {
		return this.cipherStatus || t("encryption.locked");
	}

	/**
	 * True when this vault has no key yet, so a passphrase typed here is being
	 * chosen rather than recalled, and cannot be changed afterwards.
	 */
	vaultNeedsSetup(): boolean {
		return this.vaultHasKey === false;
	}

	/** True when the vault demands a passphrase this device has not supplied. */
	isLocked(): boolean {
		return this.locked;
	}

	/** True when names are hidden too, not only content. */
	hidesNames(): boolean {
		return this._pathCipher !== null;
	}

	/** True when the vault is open and uploads are actually being encrypted. */
	encryptionReady(): boolean {
		return this.encryptionWanted() && !this.locked;
	}

	/** True when this device started encrypting the vault and has not finished. */
	migrationHere(): boolean {
		return this.migration?.mine === true;
	}

	/** The device encrypting the vault right now, when it is not this one. */
	migrationElsewhere(): string | null {
		return this.migration && !this.migration.mine ? this.migration.device : null;
	}

	/**
	 * Whether this device means to encrypt. A passphrase is the intent; there is no
	 * switch to also flip, because a switch that must agree with a field is a step
	 * that exists only to be forgotten.
	 */
	encryptionWanted(): boolean {
		return this.settings.passphrase.length > 0;
	}

	/**
	 * Bring encryption into the state the settings ask for.
	 *
	 * The key parameters live on the server, so the first device to enable encryption
	 * writes them and every other device reads them and checks the passphrase against
	 * them. That is what makes a second device able to join knowing only the words.
	 *
	 * Several things call this: loading, leaving the passphrase field, pressing the
	 * button, and every pass that finds the vault locked. On a phone the button press
	 * blurs the field first, so two of them arrive together, and a wrong passphrase
	 * used to be announced again by every pass that followed.
	 *
	 * So: one attempt at a time, and nothing said twice about the same passphrase
	 * once its outcome is known. Quiet callers, the ones that are retrying rather
	 * than being asked, say nothing at all.
	 */
	async applyEncryption(quiet = false, allowCreate = false): Promise<void> {
		if (this.unlocking) {
			if (!allowCreate || this.unlockingMayCreate) return this.unlocking;
			// Set pressed while an attempt that may not create the key is in flight:
			// on a desktop the press blurs the field first, so this is the ordinary
			// case, not a race. Taking that attempt's answer swallowed the press. Let
			// it finish, then do what was pressed, unless it already opened the vault.
			await this.unlocking.catch(() => {});
			if (this._cipher.enabled && this.settledPassphrase === this.settings.passphrase) return;
			return this.applyEncryption(quiet, true);
		}
		if (
			!allowCreate &&
			this.settledPassphrase === this.settings.passphrase &&
			(this._cipher.enabled || this.locked)
		) {
			return;
		}
		this.unlockingMayCreate = allowCreate;
		this.unlocking = this.attemptEncryption(quiet, allowCreate).finally(() => {
			this.unlocking = null;
		});
		return this.unlocking;
	}

	private async attemptEncryption(quiet: boolean, allowCreate: boolean): Promise<void> {
		if (!this.settings.passphrase) {
			// No passphrase means no encryption, unless the vault itself disagrees,
			// which the guard discovers by asking the server and locks us for.
			this._cipher = plaintext;
			this._pathCipher = null;
			this.locked = false;
			this.cipherStatus = t("encryption.off");
			return;
		}
		// The key record holds no names, so it is read through a client that needs no
		// path key. The ordinary one refuses to exist while the vault hides names and
		// the path key is not open, which is exactly when this has to run: through it,
		// a wrong passphrase could not be corrected without restarting Obsidian.
		const client = this.pathKeyMissing() ? this.ports.plainClient() : this.ports.client(false);
		if (!client) return;
		try {
			const stored = (await client.getVaultKey()) as VaultKeyRecord | null;
			this.vaultHasKey = stored !== null;
			if (stored) this.vaultHidesNames = stored.paths === "encrypted";
			this.migration = stored?.migration ?? null;
			if (stored && this.migration && !this.migration.mine) {
				// Another device is in the middle of re-uploading the vault encrypted.
				// Joining now would read a vault that is half one thing and half the
				// other. Not settled: the next pass asks again, and the wait ends on
				// its own when the marker goes.
				this._cipher = plaintext;
				this._pathCipher = null;
				this.locked = true;
				this.cipherStatus = t("encryption.inProgressElsewhere", { device: this.migration.device });
				this.ports.setStatus(this.cipherStatus);
				if (!quiet) this.ports.notice(`VaultSync: ${this.cipherStatus}`, 8000);
				return;
			}
			if (stored) {
				const cipher = await VaultCipher.unlock(this.settings.passphrase, stored);
				this._cipher = cipher;
				this._pathCipher = stored.paths === "encrypted" ? await cipher.pathCipher() : null;
				this.locked = false;
				this.announcedEncryptedVault = false;
				this.settledPassphrase = this.settings.passphrase;
				if (this.migration) {
					// Ours, and interrupted. It continues without being asked: the
					// question was answered when the button was pressed.
					this.cipherStatus = t("encryption.encrypting");
					void this.ports.encryptInPlace(quiet);
					return;
				}
				this.cipherStatus = t(
					this._pathCipher ? "encryption.readyWithPaths" : "encryption.ready",
				);
				// Whether a vault is actually hidden is the one thing somebody turning
				// this on wants confirmed. A grey caption under a text field is not a
				// confirmation.
				if (!quiet) this.ports.notice(`VaultSync: ${this.cipherStatus}`, 8000);
				// And start at once. Waiting for the timer meant a minute of nothing
				// happening on a device that had just been told everything was fine.
				void this.ports.syncNow(true);
			} else if (!allowCreate) {
				// Creating the vault key is the one irreversible act here, and it only
				// happens on the Set button. Anything else that lands with a passphrase
				// and no key, a blur half-way through typing, an automatic retry, waits
				// and says which press is missing. Losing a vault to the fragment of a
				// passphrase somebody paused in the middle of is not a risk worth the
				// convenience.
				this._cipher = plaintext;
				this._pathCipher = null;
				this.locked = true;
				this.cipherStatus = t("encryption.pressSet");
				if (!quiet) this.ports.notice(`VaultSync: ${this.cipherStatus}`, 8000);
			} else {
				// The same key record whether the vault starts empty or full: names
				// hidden, content hidden. A vault that already holds readable files is
				// brought to that state by encryptInPlace, right after the key is set.
				const stats = await client.stats();
				const occupied = Number(stats["files"] ?? 0) + Number(stats["folders"] ?? 0) > 0;
				if (occupied) {
					// Asked before the key is set, because a key cannot be taken back: a
					// device that excludes files other devices keep cannot encrypt them,
					// and erasing their readable copies would lose them.
					const plain = this.ports.plainClient();
					const excluded = await this.ports.excludedOnServer(plain);
					if (excluded.length > 0) {
						this._cipher = plaintext;
						this._pathCipher = null;
						this.locked = true;
						this.cipherStatus = t("encryption.excludedOnServer", { paths: listPaths(excluded) });
						this.ports.notice(`VaultSync: ${this.cipherStatus}`, 15000);
						return;
					}
				}
				const { cipher, params } = await VaultCipher.create(this.settings.passphrase);
				this.vaultHasKey = true;
				this.vaultHidesNames = true;
				await client.putVaultKey(params);
				this._cipher = cipher;
				this._pathCipher = await cipher.pathCipher();
				this.locked = false;
				this.announcedEncryptedVault = false;
				this.settledPassphrase = this.settings.passphrase;
				if (occupied) {
					this.cipherStatus = t("encryption.encrypting");
					await this.ports.encryptInPlace(quiet);
					return;
				}
				this.cipherStatus = t("encryption.created");
				if (!quiet) this.ports.notice(t("encryption.created"), 10000);
				void this.ports.syncNow(true);
			}
		} catch (e) {
			// A wrong passphrase must never fall back to writing plaintext: that would
			// quietly publish the notes this setting exists to hide.
			this._cipher = plaintext;
			this._pathCipher = null;
			this.locked = true;
			// A wrong passphrase is a settled answer and is said once. Anything else,
			// a server that was not there yet, stays unsettled so the next pass tries
			// again without a word.
			if (e instanceof WrongPassphrase) {
				this.cipherStatus = t("encryption.wrong");
				this.settledPassphrase = this.settings.passphrase;
				if (!quiet) this.ports.notice(`VaultSync: ${this.cipherStatus}`, 10000);
			} else {
				this.cipherStatus = t("encryption.failed", {
					message: e instanceof Error ? e.message : String(e),
				});
				if (!quiet && !isUnreachable(this.cipherStatus)) {
					this.ports.notice(`VaultSync: ${this.cipherStatus}`, 10000);
				}
			}
			throw e;
		}
	}

	/**
	 * Why syncing must not happen, or empty when it may.
	 *
	 * The important case is a vault that is encrypted while this device is not set up
	 * for it. Reading it anyway produces filenames that are ciphertext and content
	 * that is noise, and the device then tries to create files with those names. Far
	 * better to notice, refuse, and say which of the two things is missing.
	 */
	async reasonNotToSync(manual = false): Promise<string> {
		// The passphrase is already here. Unlocking is something to do, not something
		// to ask for again: the first attempt may simply have run before the network
		// was ready, and making somebody press a button to recover from that is
		// making them do the software's retry by hand.
		if (this.settings.passphrase && !this._cipher.enabled) {
			try {
				// Quiet: this is a retry nobody asked for, and its failure has already
				// been reported by whoever did ask.
				await this.applyEncryption(true);
			} catch {
				// A wrong passphrase, and applyEncryption has already said so.
			}
		}
		if (this.locked) return this.cipherStatus;
		if (this._cipher.enabled) return "";

		const client = this.ports.client(false);
		if (!client) return "";
		try {
			const key = (await client.getVaultKey()) as VaultKeyRecord | null;
			this.vaultHasKey = key !== null;
			if (key) this.vaultHidesNames = key.paths === "encrypted";
			if (!key) {
				// Answered at last, so the wait the status bar described is over.
				if (this.cipherStatus === t("status.keyUnknown")) this.cipherStatus = t("encryption.off");
				// No key and no passphrase. Before the very first upload of an existing
				// vault into an empty server, that combination must not start on its
				// own: whatever goes up now goes up readable, permanently, and the
				// person may simply not have reached the passphrase field yet. One
				// explicit Sync now says they have decided; a server that already
				// holds files says the decision was made earlier.
				if (!manual) {
					const localFiles = this.ports.localFileCount();
					if (localFiles > 0 && (await this.ports.serverIsEmpty(client))) {
						this.cipherStatus = t("encryption.firstSyncChoice", {
							count: localFiles,
						});
						this.ports.setStatus(this.cipherStatus);
						if (!this.announcedEncryptedVault) {
							this.announcedEncryptedVault = true;
							this.ports.notice(`VaultSync: ${this.cipherStatus}`, 15000);
						}
						return this.cipherStatus;
					}
				}
				return "";
			}
		} catch {
			// Cannot tell. Already told "no key" this session, this is a hiccup and
			// refusing would help nobody. Never told, the vault may hide its names, and
			// a plaintext pass would publish readable ones (see mayPassWithoutKeyAnswer).
			// Said on the status bar only: offline, every pass lands here.
			if (mayPassWithoutKeyAnswer(this.vaultHasKey)) return "";
			this.cipherStatus = t("status.keyUnknown");
			this.ports.setStatus(this.cipherStatus);
			return this.cipherStatus;
		}
		// The vault has a key and this device has none.
		this.locked = true;
		this.cipherStatus = t(
			this.encryptionWanted() ? "encryption.locked" : "encryption.vaultIsEncrypted",
		);
		this.ports.setStatus(this.cipherStatus);
		if (!this.announcedEncryptedVault) {
			this.announcedEncryptedVault = true;
			this.ports.notice(`VaultSync: ${this.cipherStatus}`, 15000);
		}
		return this.cipherStatus;
	}
}

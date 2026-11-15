// SPDX-License-Identifier: MIT

import { MarkdownView, Notice, Plugin, TAbstractFile, TFile, normalizePath, Platform } from "obsidian";
import { ApiError, SyncClient, redeemJoin } from "./api";
import { ConflictModal } from "./conflict-modal";
import { showConflictNotice } from "./conflict-notice";
import { RestoreModal } from "./restore-modal";
import { ReadOnlyOffModal, ReadOnlyOnModal } from "./read-only-modal";
import { AddDeviceModal } from "./onboarding";
import { EncryptionController, isUnreachable } from "./encryption-controller";
import { t } from "./i18n";
import { IdleBackoff } from "./backoff";
import { LocalIndex } from "./index-store";
import { defaultDeviceName, toNFC } from "./paths";
import { SyncEngine, type SyncReport } from "./sync-engine";
import { DEFAULT_SETTINGS, SyncSettingsTab, type SyncSettings, defaultExcludes } from "./settings";

/** How long to wait after the last edit before syncing. Obsidian fires on every keystroke. */
const DEBOUNCE_MS = 2500;

/**
 * How often to ask the server for changes while things are happening. Each pass
 * that moves nothing doubles the wait, up to IDLE_INTERVAL_MAX_MS; an edit here,
 * a change that comes down, a "Sync now", or bringing the app back to the front
 * returns it to this. Edits made here never wait for it: they are sent after DEBOUNCE_MS.
 */
const SYNC_INTERVAL_MS = 15_000;
const IDLE_INTERVAL_MAX_MS = 5 * 60_000;

/** How many journal lines to keep. Enough to cover a bad afternoon, not a month. */
const JOURNAL_LINES = 2000;

/** Whether a pass changed anything on either side, which keeps the checks frequent. */
function moved(r: SyncReport): boolean {
	return r.uploaded + r.downloaded + r.deleted + r.renamed + r.merged + r.conflicts + r.kept > 0;
}

export default class LockstepPlugin extends Plugin {
	override settings: SyncSettings = { ...DEFAULT_SETTINGS };
	index!: LocalIndex;
	private engine!: SyncEngine;
	private statusBar: HTMLElement | null = null;
	private lastStatus = t("status.notConnected");
	private debounce: number | null = null;
	/** A server that cannot be reached says so once, not once a minute. */
	private announcedUnreachable = false;
	private focusPassphrase = false;
	private encryption!: EncryptionController;
	/** Which vault on the server this device is bound to, as the server names it. */
	private serverVault = "";
	/** Whether the bound server vault holds nothing yet. Cached once it is false. */
	private serverEmpty: boolean | null = null;
	/** How many files the server reported last time it was asked. */
	private serverFiles = 0;
	/** The next automatic check. A timeout re-armed after each pass, not an interval. */
	private autoTimer: number | null = null;
	private backoff = new IdleBackoff(SYNC_INTERVAL_MS, IDLE_INTERVAL_MAX_MS);
	/** Set on unload; a running pass stops at the next file and writes nothing more. */
	private unloaded = false;

	/** Places on the settings screen that mirror sync progress while it is open. */
	progressTargets: HTMLElement[] = [];
	/**
	 * On a phone there is no status bar, so a long sync was invisible: it had
	 * started, and nothing on screen said how far it was. One notice, updated in
	 * place and taken down at the end, is the phone's status bar.
	 */
	private progressNotice: Notice | null = null;
	private progressNoticeAt = 0;
	/**
	 * The "Done" toast from the last pass, kept so the next pass can take it down
	 * before showing its own. On a phone a burst of typing schedules several passes
	 * a few seconds apart, and each used to leave its own six-second toast, so three
	 * of them stacked on top of the text being written.
	 */
	private summaryNotice: Notice | null = null;
	/** The last completed sync's summary, shown once where the progress was. */
	lastSummary: string | null = null;

	showProgress(text: string): void {
		for (const el of this.progressTargets) el.setText(text);
		if (!Platform.isMobile) return;
		const now = Date.now();
		if (this.progressNotice && now - this.progressNoticeAt < 400) return;
		this.progressNoticeAt = now;
		if (!this.progressNotice) this.progressNotice = new Notice(text, 0);
		else this.progressNotice.setMessage(text);
	}

	/** Take the phone's progress notice down; say how it ended if there was one. */
	private endProgress(summary: string | null): void {
		if (!this.progressNotice) return;
		this.progressNotice.hide();
		this.progressNotice = null;
		if (summary) {
			// One "Done" toast at a time: replace the previous rather than stack on it.
			this.summaryNotice?.hide();
			this.summaryNotice = new Notice(summary, 4000);
		}
	}

	/** Decision journal, flushed to disk after every pass. */
	private journal: string[] = [];
	private journalDirty = false;

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.encryption = new EncryptionController({
			settings: () => this.settings,
			client: (complain) => this.client(complain),
			plainClient: () =>
				new SyncClient(
					this.settings.serverUrl,
					this.settings.token,
					this.settings.deviceName,
					null,
					this.settings.readOnly,
				),
			notice: (text, ms) => new Notice(text, ms),
			setStatus: (text) => this.setStatus(text),
			syncNow: (quiet) => this.syncNow(quiet),
			encryptInPlace: (quiet) => this.encryptInPlace(quiet),
			excludedOnServer: (plain) => this.engine.excludedOnServer(plain),
			localFileCount: () => this.app.vault.getFiles().length,
			serverIsEmpty: (client) => this.serverIsEmpty(client),
		});

		const dir = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		this.index = new LocalIndex(this.app.vault.adapter, dir);
		await this.index.load();

		this.engine = new SyncEngine({
			app: this.app,
			index: this.index,
			settings: this.settings,
			client: () => this.client(false),
			cipher: () => this.encryption.cipher,
			guard: (manual) => this.encryption.reasonNotToSync(manual),
			listLocalFiles: () => this.app.vault.getFiles().map((f) => f.path),
			stopped: () => this.unloaded,
			serverFileCount: () => this.serverFiles,
			scratchDir: dir,
			trace: (line) => this.traceLine(line),
			onProgress: (done, total, path) => {
				// Movement while a long sync runs, and a percentage where the total is
				// known. Somebody watching a first sync needs to see how far it is, not
				// a word that never changes.
				const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
				const text =
					total > 0
						? t(
								this.engine.phase === "encrypt"
									? "progress.encrypting"
									: this.engine.busy && this.engine.phase === "pull"
										? "progress.download"
										: this.encryption.cipher.enabled
										? "progress.encrypted"
										: "progress.plain",
								{ pct, done, total },
							)
						: t("status.progress", { done, path: path.split("/").pop() ?? path });
				this.setStatus(text);
				this.showProgress(text);
			},
			onConflict: (path) => {
				// Ask right here rather than sending anybody to a settings screen. The
				// same conflict also stays in the list, so ignoring the notice costs
				// nothing.
				const pending = this.index.conflicts.find((c) => c.path === path);
				if (pending) {
					showConflictNotice(pending, (choice) => this.resolveConflict(path, choice));
				} else {
					new Notice(t("notice.conflictQueued", { path }), 12000);
				}
			},
			log: (message, error) => console.warn(`[vaultsync] ${message}`, error ?? ""),
		});

		this.addSettingTab(new SyncSettingsTab(this.app, this));
		this.statusBar = this.addStatusBarItem();
		this.setStatus(t("status.index", { files: this.index.size, seq: this.index.lastSeq }));

		this.addCommand({ id: "sync-now", name: t("cmd.sync"), callback: () => void this.syncNow() });
		// The same "Sync now", one tap away. The ribbon, unlike the status bar, is
		// there on mobile too, and the status bar's click already opens the conflicts.
		this.addRibbonIcon("refresh-cw", t("cmd.sync"), () => void this.syncNow());
		this.addCommand({ id: "pull-all", name: t("cmd.pull"), callback: () => void this.pullAll() });
		this.addCommand({
			id: "encrypt-in-place",
			name: t("cmd.encrypt"),
			callback: () => void this.encryptFromCommand(),
		});
		// A link that sets up another device. Registered before anything else, so a
		// device that has just been installed can be configured by opening one.
		this.registerObsidianProtocolHandler("vaultsync-setup", (params) => {
			void this.applySetupLink(params);
		});

		this.addCommand({
			id: "add-device",
			name: t("cmd.addDevice"),
			callback: () => this.openAddDevice(),
		});
		this.addCommand({
			id: "restore-deleted",
			name: t("cmd.restore"),
			callback: () => this.openRestore(),
		});
		this.addCommand({
			id: "reset-index",
			name: t("cmd.resetIndex"),
			callback: () => {
				void this.resetIndex().then(() => new Notice(t("notice.indexReset")));
			},
		});
		this.addCommand({
			id: "resolve-conflicts",
			name: t("cmd.conflicts"),
			callback: () => this.openConflicts(),
		});

		// The status bar is the only place a pending decision is visible on mobile,
		// where a notice from a background pass is long gone by the time the app is
		// opened again. Clicking it opens the list.
		this.statusBar?.addEventListener("click", () => this.openConflicts());

		// The vault is only watched once the workspace is ready. Obsidian replays the
		// whole tree as create events while it starts, and treating those as edits
		// would mark every file dirty on every launch.
		this.app.workspace.onLayoutReady(() => {
			// If this fails because the network is not up yet, the next pass retries.
			void this.applyEncryption(true).catch(() => {});
			this.registerVaultEvents();
			this.registerEvent(this.app.workspace.on("layout-change", () => this.enforceReadingView()));
			this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.enforceReadingView()));
			this.enforceReadingView();
			this.restartAutoSync();
			void this.syncNow(true);
		});

		// Mobile kills the app in the background, so the queue is flushed on the way out.
		this.registerDomEvent(window, "blur", () => void this.flush());
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.hidden) void this.flush();
			else this.wakeFromIdle();
		});
		this.registerDomEvent(window, "focus", () => this.wakeFromIdle());
	}

	/**
	 * Coming back to the app after a quiet spell checks at once rather than at the
	 * end of a wait that may have grown to minutes. Switching windows right after a
	 * pass, or while checks are at the base pace, triggers nothing extra.
	 */
	private wakeFromIdle(): void {
		if (this.backoff.wake(Date.now())) void this.syncNow(true);
	}

	override onunload(): void {
		this.summaryNotice?.hide();
		this.endProgress(null);
		// Async passes outlive the plugin object. Everything that could still be
		// running checks this flag between files and stops, so an updated plugin
		// does not share the vault with its own ghost.
		this.unloaded = true;
		if (this.debounce) window.clearTimeout(this.debounce);
		if (this.autoTimer !== null) window.clearTimeout(this.autoTimer);
		this.autoTimer = null;
		void this.index.save();
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<SyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
		// The configuration folder is .obsidian by default and something else when
		// the person chose so, and window state lives inside it under either name.
		if (!saved?.excludes) this.settings.excludes = defaultExcludes(this.app.vault.configDir);
		// Named for what this device is, so nobody has to correct an assumption about
		// what they own before they can start. Whatever they type instead wins.
		if (!this.settings.deviceName) {
			this.settings.deviceName = defaultDeviceName();
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		this.encryption?.settingsSaved();
		await this.saveData(this.settings);
		this.engine?.updateSettings(this.settings);
	}

	statusLine(): string {
		return this.lastStatus;
	}

	/**
	 * The journal answers the only question that matters when something synced
	 * wrongly: which branch took this entry, on this device, at that moment. It
	 * lives beside the plugin so a bug report can carry it.
	 */
	private traceLine(line: string): void {
		const stamp = new Date().toISOString().slice(11, 19);
		this.journal.push(`${stamp} ${line}`);
		if (this.journal.length > JOURNAL_LINES) {
			this.journal.splice(0, this.journal.length - JOURNAL_LINES);
		}
		this.journalDirty = true;
	}

	private async flushJournal(): Promise<void> {
		if (!this.journalDirty || this.unloaded) return;
		this.journalDirty = false;
		try {
			const dir = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
			await this.app.vault.adapter.write(`${dir}/sync-log.txt`, this.journal.join("\n") + "\n");
		} catch {
			/* a journal that cannot be written is not worth failing a sync over */
		}
	}

	/**
	 * The vault this device syncs with, by the name the server knows.
	 *
	 * What a vault is called in Obsidian is local to the device and travels nowhere.
	 * The binding is the token, and until this was shown the only way to know which
	 * vault a token opened was to press a button and read a notice.
	 */
	serverVaultName(): string {
		return this.serverVault;
	}

	private async serverIsEmpty(client: SyncClient): Promise<boolean> {
		if (this.serverEmpty === false) return false;
		try {
			const stats = await client.stats();
			this.serverFiles = Number(stats["files"] ?? 0);
			this.serverEmpty = this.serverFiles === 0 && Number(stats["seq"] ?? 0) === 0;
		} catch {
			return false; // cannot tell; do not block on a hiccup
		}
		return this.serverEmpty;
	}

	async refreshServerVault(): Promise<void> {
		const client = this.client(false);
		if (!client) {
			this.serverVault = "";
			return;
		}
		try {
			const stats = await client.stats();
			this.serverVault = String(stats["vault"] ?? "");
			this.serverFiles = Number(stats["files"] ?? 0);
			this.serverEmpty = this.serverFiles === 0 && Number(stats["seq"] ?? 0) === 0;
		} catch {
			this.serverVault = "";
		}
	}

	/** Whether the server vault holds nothing yet. Null until the server has answered. */
	serverLooksEmpty(): boolean | null {
		return this.serverEmpty;
	}

	encryptionStatus(): string {
		return this.encryption.encryptionStatus();
	}

	vaultNeedsSetup(): boolean {
		return this.encryption.vaultNeedsSetup();
	}

	isLocked(): boolean {
		return this.encryption.isLocked();
	}

	hidesNames(): boolean {
		return this.encryption.hidesNames();
	}

	encryptionReady(): boolean {
		return this.encryption.encryptionReady();
	}

	migrationHere(): boolean {
		return this.encryption.migrationHere();
	}

	migrationElsewhere(): string | null {
		return this.encryption.migrationElsewhere();
	}

	encryptionWanted(): boolean {
		return this.encryption.encryptionWanted();
	}

	/** See EncryptionController.applyEncryption. */
	applyEncryption(quiet = false, allowCreate = false): Promise<void> {
		return this.encryption.applyEncryption(quiet, allowCreate);
	}

	async getRetention(): Promise<number> {
		const client = this.client(false);
		return client ? client.getRetention() : 30;
	}

	async setRetention(days: number): Promise<void> {
		if (this.settings.readOnly) throw new Error(t("readOnly.refused"));
		const client = this.client();
		if (!client) throw new Error("not configured");
		await client.setRetention(days);
	}

	/** Drop questions that no longer have two answers. */
	async pruneConflicts(): Promise<void> {
		await this.engine.pruneConflicts();
		this.setStatus(this.lastStatus);
	}

	/** Apply a decision about a conflict and refresh what the status bar shows. */
	async resolveConflict(path: string, choice: "mine" | "server" | "merged"): Promise<void> {
		if (this.refusedReadOnly()) return;
		try {
			await this.engine.resolveConflict(path, choice);
			this.setStatus(this.lastStatus);
		} finally {
			this.syncIfAsked();
		}
	}

	/**
	 * Configure this device from a link somebody sent it.
	 *
	 * Everything except the passphrase, which is deliberately never in the link.
	 */
	private async applySetupLink(params: Record<string, string>): Promise<void> {
		let url = (params["url"] ?? "").trim();
		let token = (params["token"] ?? "").trim();
		const code = (params["code"] ?? "").trim();
		if (url && code && !token) {
			// The link from the join page: a code stands in for the token and is
			// spent here, now. The page a camera saw earlier is worthless from this
			// moment, which is the point of it.
			try {
				const joined = await redeemJoin(url, code);
				token = joined.token;
				url = joined.url || url;
				if (joined.device && !params["device"]) params["device"] = joined.device;
			} catch (e) {
				new Notice(
					e instanceof ApiError && e.status === 410
						? t("add.linkSpent")
						: t("notice.error", { what: t("add.title"), message: e instanceof Error ? e.message : String(e) }),
					10000,
				);
				return;
			}
		}
		if (!url || !token) {
			new Notice(t("add.linkBroken"), 8000);
			return;
		}
		this.settings.serverUrl = url;
		this.settings.token = token;
		this.announcedUnreachable = false;
		this.serverEmpty = null;
		this.encryption.rebound();
		if (params["device"]) this.settings.deviceName = params["device"].trim();
		await this.saveSettings();
		await this.refreshServerVault();
		// Also start a pass right away where nothing blocks it, and keep the
		// denominator fresh so the first pull shows a percentage.

		// An encrypted vault needs a passphrase before anything can happen, so the
		// switch is turned on for them and the cursor is put in the field. Telling
		// somebody to enter it "below" while they are looking at a note is not an
		// instruction, it is a riddle.
		let needsPassphrase = false;
		const client = this.client(false);
		if (client) {
			try {
				needsPassphrase = (await client.getVaultKey()) !== null;
				this.encryption.heardVaultHasKey(needsPassphrase);
			} catch {
				/* cannot tell yet; the next pass will */
			}
		}

		new Notice(
			needsPassphrase
				? t("add.linkAppliedEncrypted", { vault: this.serverVault || "?" })
				: t("add.linkApplied", { vault: this.serverVault || "?" }),
			10000,
		);
		// An encrypted vault needs the passphrase, so the settings open with the
		// cursor in the field. A readable one needs nothing: syncing starts, and the
		// status bar shows it moving. Opening the settings there put a passphrase
		// field in front of somebody who had not been asked for one.
		if (needsPassphrase) this.openSettings(true);
		else void this.syncNow(true);
	}

	/**
	 * Open this plugin's own settings, optionally with the passphrase field focused.
	 *
	 * app.setting is not in the public typings, so it is reached through a narrow
	 * shape rather than a blanket cast, and nothing breaks if it is ever missing.
	 */
	private openSettings(focusPassphrase: boolean): void {
		this.focusPassphrase = focusPassphrase;
		const host = this.app as unknown as {
			setting?: { open?: () => void; openTabById?: (id: string) => void };
		};
		try {
			host.setting?.open?.();
			host.setting?.openTabById?.(this.manifest.id);
		} catch {
			/* an older or different host; the notice already said what to do */
		}
	}

	/** Set when the settings screen should put the cursor in the passphrase field. */
	takeFocusRequest(): boolean {
		const wanted = this.focusPassphrase;
		this.focusPassphrase = false;
		return wanted;
	}

	openAddDevice(): void {
		new AddDeviceModal(
			this.app,
			async (name) => {
				const client = this.client();
				if (!client) throw new Error("not configured");
				// A page on the server with the steps in order, carrying a one-time
				// code. A server from before the page has no such route, and gets the
				// older link with the token in it, which still works everywhere.
				try {
					return (await client.createJoin(name)).url;
				} catch (e) {
					if (!(e instanceof ApiError) || e.status !== 404) throw e;
				}
				const issued = await client.issueToken(name);
				const url = encodeURIComponent(this.settings.serverUrl);
				const token = encodeURIComponent(issued.token);
				const device = encodeURIComponent(name);
				return `obsidian://vaultsync-setup?url=${url}&token=${token}&device=${device}`;
			},
			this.encryptionWanted(),
			this.settings.serverUrl,
		).open();
	}

	// --- read-only ------------------------------------------------------------

	/** True, with a notice saying why, when this device is read-only. */
	private refusedReadOnly(): boolean {
		if (!this.settings.readOnly) return false;
		new Notice(t("readOnly.refused"), 6000);
		return true;
	}

	/**
	 * Turn read-only on or off, asking first where something would otherwise be
	 * undone or sent without the person knowing. Resolves once it is settled either
	 * way, so the settings screen can show the outcome.
	 */
	setReadOnly(on: boolean): Promise<void> {
		if (on === this.settings.readOnly) return Promise.resolve();
		if (on && this.index.conflicts.length > 0) {
			// Deciding a conflict is a write, which a read-only device cannot make.
			new Notice(t("readOnly.on.conflicts", { count: this.index.conflicts.length }), 8000);
			return Promise.resolve();
		}
		if (on && this.encryption.migrationHere()) {
			// The server takes writes from nobody else until this device finishes.
			new Notice(t("readOnly.on.migrating"), 8000);
			return Promise.resolve();
		}
		return new Promise((done) => {
			if (on) {
				const pending = this.engine.pendingChanges();
				if (pending === 0) {
					void this.applyReadOnly(true).finally(done);
					return;
				}
				new ReadOnlyOnModal(
					this.app,
					pending,
					async (choice) => {
						if (choice === "sync") {
							await this.syncNow(true);
							if (this.engine.pendingChanges() > 0) {
								new Notice(t("readOnly.on.stillPending"), 8000);
								return;
							}
						}
						await this.applyReadOnly(true);
					},
					done,
				).open();
				return;
			}
			const files = this.engine.filesOnlyHere();
			if (files.length === 0) {
				void this.applyReadOnly(false).finally(done);
				return;
			}
			new ReadOnlyOffModal(this.app, files, (keep) => this.applyReadOnly(false, keep), done).open();
		});
	}

	private async applyReadOnly(on: boolean, keepHere: string[] = []): Promise<void> {
		await this.engine.switchReadOnly(on, keepHere);
		this.settings.readOnly = on;
		await this.saveSettings();
		this.enforceReadingView();
		this.setStatus(this.lastStatus);
		new Notice(t(on ? "readOnly.turnedOn" : "readOnly.turnedOff"));
		this.scheduleSync();
	}

	/**
	 * On a read-only device every open note shows in reading view. Obsidian has no
	 * read-only editor for plugins, so a note switched to editing is switched back;
	 * whatever is changed some other way is put back by the next sync.
	 */
	private enforceReadingView(): void {
		if (!this.settings.readOnly) return;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView) || leaf.view.getMode() !== "source") return;
			const state = leaf.getViewState();
			void leaf.setViewState({ ...state, state: { ...state.state, mode: "preview" } });
		});
	}

	openRestore(): void {
		if (this.refusedReadOnly()) return;
		new RestoreModal(
			this.app,
			() => this.engine.deletedFiles(),
			async (file) => {
				try {
					await this.engine.restore(file.path, file.rev, file.content_rev);
				} finally {
					this.syncIfAsked();
				}
			},
		).open();
	}

	openConflicts(): void {
		if (this.refusedReadOnly()) return;
		void this.engine.pruneConflicts();
		new ConflictModal(
			this.app,
			() => this.index.conflicts,
			(path, choice) => this.resolveConflict(path, choice),
		).open();
	}

	private setStatus(text: string): void {
		this.lastStatus = text;
		const pending = this.index?.conflicts.length ?? 0;
		const parts = [`${t("status.prefix")}: ${text}`];
		// A word rather than a symbol: the state has to be readable at a glance, and
		// an icon makes somebody guess at what it is trying to say.
		if (this.encryptionWanted() || this.encryption.isLocked()) {
			parts.push(this.encryption.isLocked() ? t("status.lockedShort") : t("status.encrypted"));
		}
		if (this.settings.readOnly) parts.push(t("status.readOnly"));
		if (pending > 0) parts.push(t("conflict.pending", { count: pending }));
		this.statusBar?.setText(parts.join(" · "));
	}

	private client(complain = true): SyncClient | null {
		if (!this.settings.serverUrl || !this.settings.token) {
			if (complain) new Notice(t("notice.noConfig"));
			return null;
		}
		// The vault stores files under sealed names. A client built without the path
		// key would read nothing and, worse, write real names to the server, which is
		// exactly the leak the sealed names exist to prevent. Content and paths are
		// sealed by two separate objects, so whatever race or bug leaves the path key
		// behind must stall the sync here rather than reach the network.
		if (this.encryption.pathKeyMissing()) {
			this.traceLine("refused to build a client: names are sealed and the path key is not ready");
			if (complain) new Notice(`VaultSync: ${t("encryption.locked")}`, 8000);
			return null;
		}
		return new SyncClient(
			this.settings.serverUrl,
			this.settings.token,
			this.settings.deviceName,
			this.encryption.pathCipher,
			this.settings.readOnly,
		);
	}

	// --- watching the vault ---------------------------------------------------

	private registerVaultEvents(): void {
		// Folders are not sent. Obsidian raises the same events for them as for files,
		// and treating one as a file means trying to read a directory and upload it,
		// which fails once per folder and says so. Parents are created on the way in
		// when a file inside them arrives, so nothing is lost by ignoring them.
		const mark = (file: TAbstractFile) => {
			if (file instanceof TFile) this.markDirty(file.path);
		};
		this.registerEvent(this.app.vault.on("create", mark));
		this.registerEvent(this.app.vault.on("modify", mark));
		this.registerEvent(this.app.vault.on("delete", mark));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) this.onRename(file.path, oldPath);
			}),
		);
	}

	private markDirty(rawPath: string): void {
		const path = toNFC(rawPath);
		if (this.engine.isSuppressed(path) || this.engine.isExcluded(path)) return;
		// A conflict copy or backup, edited by the person: still theirs, still not sent.
		// Renaming one to a name of their own is what takes it into the sync.
		if (this.engine.isLocalOnly(path)) return;
		const known = this.index.get(path);

		// A path the server has never seen, disappearing. There is nothing to report:
		// a conflict copy deleted by hand used to end up here, and the plugin would
		// spend every pass telling the server to delete a file it never had.
		if (!known && !this.app.vault.getAbstractFileByPath(path)) return;

		// The base revision did not change because the file was edited, so what the
		// index knows about it is kept. Rebuilding the entry from nothing here used to
		// drop the plaintext hash, and everything downstream that leaned on it then
		// mistook ordinary files for local edits.
		this.index.set(path, {
			base_rev: known?.base_rev ?? 0,
			base_hash: known?.base_hash ?? "",
			plain_hash: known?.plain_hash,
			local_hash: known?.local_hash ?? "",
			mtime: Date.now(),
			dirty: true,
		});
		this.scheduleSync();
	}

	private onRename(rawTo: string, rawFrom: string): void {
		const to = toNFC(rawTo);
		const from = toNFC(rawFrom);
		if (this.engine.isSuppressed(to) || this.engine.isSuppressed(from)) return;
		if (this.engine.isExcluded(to) || this.engine.isExcluded(from)) return;

		const known = this.index.get(from);
		if (known && known.base_rev > 0) {
			this.index.queueRename({ from, to, base_rev: known.base_rev });
			this.index.set(to, { ...known, mtime: Date.now(), dirty: known.dirty ?? false });
			this.index.remove(from);
		} else {
			// The server has never seen this file, so there is nothing to move. It goes
			// up as an ordinary new file under its new name.
			this.markDirty(to);
		}
		this.scheduleSync();
	}

	/**
	 * Schedule the pass somebody asked for while the engine was busy. Called after
	 * everything here that holds the engine, since a request can arrive during any
	 * of them. The pass is an ordinary one even when the request was "Sync now": a
	 * press made before the pass that found held-back deletions had said so must not
	 * count as the answer to that warning.
	 */
	private syncIfAsked(): void {
		if (this.engine.takeQueued() && !this.unloaded) this.scheduleSync();
	}

	private scheduleSync(): void {
		this.backoff.active();
		if (this.debounce) window.clearTimeout(this.debounce);
		this.debounce = window.setTimeout(() => void this.syncNow(true), DEBOUNCE_MS);
	}

	restartAutoSync(): void {
		this.backoff.active();
		this.armAutoSync();
	}

	/**
	 * Arm the next automatic check, replacing any already armed. Called after every
	 * pass, whatever started it, so the wait always counts from the last contact
	 * with the server.
	 */
	private armAutoSync(): void {
		if (this.autoTimer !== null) window.clearTimeout(this.autoTimer);
		this.autoTimer = null;
		if (this.unloaded) return;
		this.autoTimer = window.setTimeout(() => {
			this.autoTimer = null;
			// A check that returns before a pass (not configured, blocked, busy) did
			// not re-arm, so the chain is picked up here.
			void this.syncNow(true).finally(() => {
				if (this.autoTimer === null) this.armAutoSync();
			});
		}, this.backoff.delay);
	}

	/** Force a pass right now, used when the app is about to be suspended. */
	private async flush(): Promise<void> {
		if (this.debounce) {
			window.clearTimeout(this.debounce);
			this.debounce = null;
		}
		await this.syncNow(true);
	}

	// --- the operations -------------------------------------------------------

	async syncNow(quiet = false): Promise<void> {
		if (!this.client(!quiet)) return;
		if (this.blocked(quiet)) return;
		if (this.engine.busy) {
			// Something that writes is running. The engine remembers the request and the
			// holder schedules a pass when it is done; dropping it lost a "Sync now".
			void this.engine.sync(!quiet);
			if (!quiet) new Notice(t("notice.syncQueued"));
			return;
		}
		const started = Date.now();
		this.setStatus(t("status.syncing"));
		if (!quiet) new Notice(t("notice.syncing"));
		try {
			const report = await this.engine.sync(!quiet);
			const secs = ((Date.now() - started) / 1000).toFixed(1);
			this.report(report, secs, quiet);
			this.backoff.finished(moved(report), Date.now(), !quiet);
			if (report.uploaded + report.downloaded > 0 && report.errors.length === 0) {
				this.lastSummary = t(this.encryption.cipher.enabled ? "progress.doneEncrypted" : "progress.done");
				for (const el of this.progressTargets) el.setText(this.lastSummary);
			}
		} catch (e) {
			// A server that cannot be reached is not asked every fifteen seconds either.
			this.backoff.finished(false, Date.now());
			this.reportError(t("error.sync"), e);
		} finally {
			this.armAutoSync();
			this.endProgress(this.lastSummary);
			await this.flushJournal();
			this.syncIfAsked();
		}
	}

	/**
	 * The command palette's way in. Right after loading, the plugin may not have
	 * asked the server about the key yet, so the first step is to let that settle;
	 * then the passphrase either creates the key and starts the re-upload, or opens
	 * an existing one and continues an interrupted run.
	 */
	private async encryptFromCommand(): Promise<void> {
		if (this.refusedReadOnly()) return;
		if (!this.settings.passphrase) {
			new Notice(`VaultSync: ${t("encryption.pressSet")}`, 8000);
			return;
		}
		try {
			await this.applyEncryption(true);
			if (!this.encryption.cipher.enabled) await this.applyEncryption(false, true);
			else await this.encryptInPlace(false);
		} catch {
			/* already reported */
		}
	}

	/**
	 * Re-upload the vault encrypted and erase the readable copies. Runs from the
	 * device that pressed the button, and again on the next start if it was cut
	 * short. The engine does the work; this is the reporting around it.
	 */
	async encryptInPlace(quiet = false): Promise<void> {
		const cipher = this.encryption.cipher;
		const paths = this.encryption.pathCipher;
		if (!cipher.enabled || !paths) return;
		// Re-uploading the vault is a write; a read-only device leaves it to another.
		if (this.settings.readOnly) return;
		const sealed = this.client(!quiet);
		if (!sealed) return;
		if (this.engine.busy) {
			if (!quiet) new Notice(t("encryption.busy"));
			return;
		}
		const plain = new SyncClient(this.settings.serverUrl, this.settings.token, this.settings.deviceName, null);
		const started = Date.now();
		this.setStatus(t("encryption.encrypting"));
		this.showProgress(t("encryption.encrypting"));
		try {
			const report = await this.engine.encryptInPlace({
				plain,
				sealed,
				cipher,
				paths,
			});
			this.encryption.migrationFinished();
			this.serverEmpty = null;
			await this.refreshServerVault();
			const secs = ((Date.now() - started) / 1000).toFixed(0);
			this.lastSummary = t("progress.doneMigrated");
			this.showProgress(this.lastSummary);
			this.setStatus(this.lastSummary);
			new Notice(
				t("encryption.migrated", { files: report.uploaded + report.kept, secs }),
				12000,
			);
			this.scheduleSync();
		} catch (e) {
			if (this.unloaded) return;
			// The marker stays on the server and the passphrase stays here, so the
			// next start, or the button, does the rest.
			this.reportError(t("encryption.migrateStopped"), e);
			this.showProgress(t("encryption.migrateStopped"));
		} finally {
			this.endProgress(this.lastSummary);
			await this.flushJournal();
			this.syncIfAsked();
		}
	}

	private report(report: SyncReport, secs: string, quiet: boolean): void {
		const touched =
			report.downloaded + report.uploaded + report.merged + report.conflicts + report.deleted + report.kept;
		let line =
			touched === 0
				? t("status.upToDate", { seq: this.index.lastSeq })
				: t("status.syncSummary", {
						secs,
						downloaded: report.downloaded,
						uploaded: report.uploaded,
						merged: report.merged,
						conflicts: report.conflicts,
					});
		// Said every time, quiet or not: something typed here was replaced.
		if (report.kept > 0) line += ` · ${t("readOnly.kept", { count: report.kept })}`;
		// A pass the barrier stopped did nothing, and "up to date" would say otherwise.
		const status = this.encryption.status;
		const barrier = status !== "" && report.errors.includes(status);
		this.setStatus(barrier ? status : line);
		if (barrier) {
			// The other barriers announce themselves from the guard; this one does not,
			// since offline it would on every pass, so a sync asked for by hand says it.
			if (!quiet && status === t("status.keyUnknown")) {
				new Notice(`VaultSync: ${status}`, 8000);
			}
		} else if (!quiet || report.conflicts > 0 || report.kept > 0) {
			new Notice(t("notice.syncDone", { summary: line }));
		}
		// The barrier is a state, already on the status bar and already announced
		// once. Reported as a sync error too, it doubled every notice around it.
		const errors = report.errors.filter((e) => e !== status);
		const unreachable = errors.filter((e) => isUnreachable(e));
		if (unreachable.length > 0) {
			if (!this.announcedUnreachable) {
				this.announcedUnreachable = true;
				new Notice(t("notice.unreachable", { url: this.settings.serverUrl }), 12000);
			}
			return;
		}
		this.announcedUnreachable = false;
		for (const err of errors.slice(0, 3)) {
			new Notice(t("notice.error", { what: t("error.sync"), message: err }), 8000);
		}
	}

	/** True when encryption is on and the vault is not open. Nothing may move. */
	private blocked(quiet: boolean): boolean {
		if (!this.encryption.isLocked()) return false;
		this.setStatus(this.encryption.status);
		if (!quiet) new Notice(`VaultSync: ${this.encryption.status}`, 8000);
		return true;
	}

	async resetIndex(): Promise<void> {
		this.index.reset();
		await this.index.save();
		this.setStatus(t("status.indexReset"));
	}

	/**
	 * Take the whole vault from the server without sending anything back.
	 *
	 * Kept as a separate operation from the sync: it is what you run on a new device,
	 * and it never deletes a local file. Anything that differs is copied aside first.
	 * The engine does the work; this is the reporting around it.
	 */
	async pullAll(): Promise<void> {
		if (!this.client()) return;
		if (this.blocked(false)) return;
		const started = Date.now();
		new Notice(t("notice.pullStarted"));
		try {
			const report = await this.engine.pullAll();
			if (report.barrier) {
				// Asked for by hand, so it is said even if a pass said it before.
				this.setStatus(report.barrier);
				new Notice(`VaultSync: ${report.barrier}`, 8000);
				return;
			}
			const secs = ((Date.now() - started) / 1000).toFixed(1);
			const line = t("status.pullSummary", {
				downloaded: report.downloaded + report.kept,
				skipped: report.skipped + report.left,
				kept: report.kept,
				secs,
			});
			this.setStatus(line);
			new Notice(t("notice.pullDone", { summary: line }));
			for (const err of report.errors.slice(0, 3)) {
				new Notice(t("notice.error", { what: t("error.pull"), message: err }), 8000);
			}
		} catch (e) {
			this.reportError(t("error.pull"), e);
		} finally {
			this.endProgress(null);
			await this.flushJournal();
			this.syncIfAsked();
		}
	}

	private reportError(what: string, e: unknown): void {
		const msg =
			e instanceof ApiError
				? `${e.status} ${e.kind}: ${e.message}`
				: e instanceof Error
					? e.message
					: String(e);
		console.error(`[vaultsync] ${what}:`, e);
		this.setStatus(t("status.error", { message: msg }));
		if (isUnreachable(msg)) {
			if (this.announcedUnreachable) return;
			this.announcedUnreachable = true;
			new Notice(t("notice.unreachable", { url: this.settings.serverUrl }), 12000);
			return;
		}
		new Notice(t("notice.error", { what, message: msg }), 8000);
	}
}

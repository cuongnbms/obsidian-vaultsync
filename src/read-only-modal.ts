// SPDX-License-Identifier: MIT

import { App, Modal, Setting } from "obsidian";
import { t } from "./i18n";

/**
 * Turning read-only on while this device holds changes the server has not had.
 *
 * A read-only device puts every such change back to the server's version (keeping
 * a copy here), so the person decides first whether they go up.
 */
export class ReadOnlyOnModal extends Modal {
	constructor(
		app: App,
		private pending: number,
		private choose: (choice: "sync" | "replace") => Promise<void>,
		private done: () => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		new Setting(contentEl).setName(t("readOnly.on.title")).setHeading();
		contentEl.createEl("p", { text: t("readOnly.on.pending", { count: this.pending }) });
		new Setting(contentEl)
			.addButton((b) =>
				b
					.setCta()
					.setButtonText(t("readOnly.on.sync"))
					.onClick(() => this.pick("sync")),
			)
			.addButton((b) => b.setButtonText(t("readOnly.on.replace")).onClick(() => this.pick("replace")))
			.addButton((b) => b.setButtonText(t("readOnly.cancel")).onClick(() => this.close()));
	}

	private picked = false;

	private pick(choice: "sync" | "replace"): void {
		this.picked = true;
		this.close();
		void this.choose(choice).finally(this.done);
	}

	override onClose(): void {
		this.contentEl.empty();
		// A choice reports when its work is over; closing without one, right away.
		if (!this.picked) this.done();
	}
}

/**
 * Turning read-only off while this device has files the server never had.
 *
 * The next pass would send them all, daily notes a plugin made on its own included,
 * so each is offered: on to send it, off to keep it on this device only.
 */
export class ReadOnlyOffModal extends Modal {
	private send: Set<string>;
	private confirmed = false;

	constructor(
		app: App,
		private files: string[],
		private confirm: (keepHere: string[]) => Promise<void>,
		private done: () => void,
	) {
		super(app);
		this.send = new Set(files);
	}

	override onOpen(): void {
		const { contentEl } = this;
		new Setting(contentEl).setName(t("readOnly.off.title")).setHeading();
		contentEl.createEl("p", { text: t("readOnly.off.intro", { count: this.files.length }) });
		for (const path of this.files) {
			new Setting(contentEl).setName(path).addToggle((toggle) =>
				toggle.setValue(true).onChange((on) => {
					if (on) this.send.add(path);
					else this.send.delete(path);
				}),
			);
		}
		new Setting(contentEl)
			.addButton((b) =>
				b
					.setCta()
					.setButtonText(t("readOnly.off.confirm"))
					.onClick(() => {
						const keep = this.files.filter((p) => !this.send.has(p));
						this.confirmed = true;
						this.close();
						void this.confirm(keep).finally(this.done);
					}),
			)
			.addButton((b) => b.setButtonText(t("readOnly.cancel")).onClick(() => this.close()));
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.confirmed) this.done();
	}
}

// The Projects dialog: save the current work under a name, and open, download or delete saved
// projects. Also the "Recent projects" row on the start screen.

import * as api from "../api";
import type { Project } from "../api";
import { PROJECT_EXT } from "../project";
import { fmtBytes, h } from "./dom";

export interface ProjectHooks {
  hasBackend(): boolean;
  canSave(): boolean; // an image is open
  current(): { file: string | null; name: string } | null; // the project being worked on
  suggestedName(): string;
  /** Save under `name`, over the saved project `replace` if given. True when saved. */
  save(name: string, replace: string | null): Promise<boolean>;
  open(p: Project): Promise<void>;
  openFile(): void;
  download(name: string): void;
  deleted(p: Project): void;
}

/** The file name the backend gives a project called `name` (see _new_path in server.py). */
export function projectFile(name: string): string {
  const stem = name.replace(/[^A-Za-z0-9 _-]+/g, "").replace(/^[ .\-_]+|[ .\-_]+$/g, "").slice(0, 60) || "project";
  return stem + PROJECT_EXT;
}

export function fmtSaved(seconds: number): string {
  const d = new Date(seconds * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { year: sameYear ? undefined : "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** A saved project as a tile: its depth-map preview, name and date. */
export function projectTile(p: Project, onOpen: () => void, extra: { current?: boolean; actions?: HTMLElement[] } = {}): HTMLElement {
  const img = h("img", { src: p.preview, alt: "", loading: "lazy", draggable: "false" });
  img.addEventListener("error", () => img.replaceWith(h("div", { class: "project-thumb-none" }, "No preview")), { once: true });
  return h("div", { class: `project-tile${extra.current ? " on" : ""}` },
    h("button", { class: "project-open", onclick: onOpen, "data-tip": `Open ${p.name} (${fmtBytes(p.bytes)})` },
      img, h("span", { class: "project-name" }, p.name), h("span", { class: "project-date" }, fmtSaved(p.saved))),
    extra.actions?.length ? h("div", { class: "project-actions" }, ...extra.actions) : null);
}

export class ProjectsDialog {
  private dialog = h("dialog", { class: "dialog projects-dialog", "aria-label": "Projects" }) as HTMLDialogElement;
  private list: Project[] = [];
  private folder = "";
  private error = "";

  constructor(private hooks: ProjectHooks) {
    document.body.append(this.dialog);
    // Click on the backdrop closes it.
    this.dialog.addEventListener("click", (e) => e.target === this.dialog && this.dialog.close());
  }

  get isOpen() {
    return this.dialog.open;
  }

  async show() {
    this.render(true);
    if (!this.dialog.open) this.dialog.showModal();
    (this.dialog.querySelector(".project-name-input") as HTMLInputElement | null)?.select();
    await this.refresh();
  }

  close() {
    this.dialog.close();
  }

  private async refresh() {
    if (!this.hooks.hasBackend()) return;
    try {
      const r = await api.getProjects();
      this.list = r.projects;
      this.folder = r.folder;
      this.error = "";
    } catch (err) {
      this.error = `Couldn't list the projects: ${(err as Error).message}`;
    }
    if (this.dialog.open) this.render(false);
  }

  private render(loading: boolean) {
    const backend = this.hooks.hasBackend();
    const cur = this.hooks.current();
    const typed = (this.dialog.querySelector(".project-name-input") as HTMLInputElement | null)?.value;
    const input = h("input", { type: "text", class: "project-name-input", value: typed ?? this.hooks.suggestedName(), "aria-label": "Project name", maxlength: 60,
      spellcheck: "false" }) as HTMLInputElement;
    const saveBtn = h("button", { class: "btn" }, "Save") as HTMLButtonElement;
    const note = h("div", { class: "note" });
    const target = () => {
      const file = projectFile(input.value.trim());
      return this.list.find((p) => p.file === file) ?? null;
    };
    const update = () => {
      const t = target();
      const empty = !input.value.trim();
      saveBtn.disabled = empty || !this.hooks.canSave();
      if (!backend) {
        saveBtn.textContent = "Download";
        note.textContent = "Without the Python backend, a project is saved as a file you keep (it opens again with Open project file…).";
      } else if (t && t.file !== cur?.file) {
        saveBtn.textContent = "Replace";
        note.className = "note warn";
        note.textContent = `Saves over the project “${t.name}” from ${fmtSaved(t.saved)}.`;
      } else {
        saveBtn.textContent = "Save";
        note.className = "note";
        note.textContent = t ? `Saves over “${t.name}”, the project you're working on.` : "Saves a new project: your images, every setting, the text and the depth maps.";
      }
    };
    const save = async () => {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      const t = target();
      if (await this.hooks.save(input.value.trim(), backend && t ? t.file : null)) this.close();
      else update();
    };
    input.addEventListener("input", update);
    input.addEventListener("keydown", (e) => e.key === "Enter" && save());
    saveBtn.addEventListener("click", save);
    update();

    const tiles = this.list.map((p) =>
      projectTile(p, () => {
        this.close();
        this.hooks.open(p);
      }, {
        current: p.file === cur?.file,
        actions: [
          h("a", { class: "icon-btn", href: p.url, download: p.file, "data-tip": "Download this project file (to keep a copy, or open it on another computer)", "aria-label": `Download ${p.name}` }, "↓"),
          h("button", { class: "icon-btn danger", "data-tip": "Delete this project", "aria-label": `Delete ${p.name}`, onclick: () => this.remove(p) }, "×"),
        ],
      }),
    );
    const parts: (HTMLElement | null)[] = [
      h("div", { class: "dialog-head" }, h("h2", {}, "Projects"),
        h("button", { class: "icon-btn", "aria-label": "Close", "data-tip": "Close (Esc)", onclick: () => this.close() }, "×")),
      this.hooks.canSave()
        ? h("section", {}, h("h3", {}, cur?.file ? "Save this project" : "Save as a project"), h("div", { class: "row project-save" }, input, saveBtn), note)
        : h("div", { class: "note" }, "Open an image to start a project you can save."),
      backend
        ? h("section", {}, h("h3", {}, "Saved projects"),
            this.error ? h("div", { class: "note bad" }, this.error)
            : tiles.length ? h("div", { class: "project-grid" }, ...tiles)
            : h("div", { class: "note" }, loading ? "Loading…" : "No saved projects yet."))
        : null,
      h("div", { class: "row dialog-foot" },
        h("button", { class: "btn ghost", onclick: () => this.hooks.openFile(), "data-tip": `Open a ${PROJECT_EXT} project file from anywhere on this computer.` }, "Open project file…"),
        backend && this.hooks.canSave()
          ? h("button", { class: "btn ghost", onclick: () => this.hooks.download(input.value.trim() || this.hooks.suggestedName()),
              "data-tip": "Save this project as a file wherever you like, without adding it to the projects folder." }, "Download as file")
          : null),
      backend && this.folder ? h("div", { class: "note" }, "Projects are saved in ", h("code", {}, this.folder), ".") : null,
    ];
    this.dialog.replaceChildren(...parts.filter((x) => x !== null));
  }

  private async remove(p: Project) {
    if (!confirm(`Delete the project “${p.name}”? This can't be undone.`)) return;
    try {
      await api.deleteProject(p.file);
      this.hooks.deleted(p);
    } catch (err) {
      this.error = `Couldn't delete ${p.name}: ${(err as Error).message}`;
    }
    await this.refresh();
  }
}

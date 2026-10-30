import type { ChapterStat } from "../download/downloader";
import { CherryPick, CherryPickRange } from "../download/cherry-pick";
import EBUS from "../event-bus";
import { Chapter } from "../page-fetcher";
import { i18n } from "../utils/i18n";
import q from "../utils/query-element";
import relocateElement from "../utils/relocate-element";

type TabID = "status" | "chapters" | "cherry-pick";

export class DownloaderPanel {

  root: HTMLElement;
  panel: HTMLElement;
  canvas: HTMLCanvasElement;
  tabStatus: HTMLElement;
  tabChapters: HTMLElement;
  tabCherryPick: HTMLElement;
  statusElement: HTMLElement;
  chaptersElement: HTMLElement;
  cherryPickElement: HTMLElement;
  noticeElement: HTMLElement;
  forceBTN: HTMLAnchorElement;
  startBTN: HTMLAnchorElement;
  btn: HTMLElement

  constructor(root: HTMLElement) {
    this.root = root;
    this.btn = q("#downloader-panel-btn", root);
    this.panel = q("#downloader-panel", root);
    this.canvas = q<HTMLCanvasElement>("#downloader-canvas", root);
    this.tabStatus = q("#download-tab-status", root);
    this.tabChapters = q("#download-tab-chapters", root);
    this.tabCherryPick = q("#download-tab-cherry-pick", root);
    this.statusElement = q("#download-status", root);
    this.chaptersElement = q("#download-chapters", root);
    this.cherryPickElement = q("#download-cherry-pick", root);
    this.noticeElement = q("#download-notice", root);
    this.forceBTN = q<HTMLAnchorElement>("#download-force", root);
    this.startBTN = q<HTMLAnchorElement>("#download-start", root);
    this.panel.addEventListener("transitionend", () => EBUS.emit("downloader-canvas-resize"));
  }

  initTabs() {
    const elements = [this.statusElement, this.chaptersElement, this.cherryPickElement];
    const tabs = [
      {
        ele: this.tabStatus, cb: () => {
          elements.forEach((e, i) => e.hidden = i != 0)
          EBUS.emit("downloader-canvas-resize")
        }
      },
      {
        ele: this.tabChapters, cb: () => {
          elements.forEach((e, i) => e.hidden = i != 1)
        }
      },
      {
        ele: this.tabCherryPick, cb: () => {
          elements.forEach((e, i) => e.hidden = i != 2)
          q("#download-cherry-pick-input", this.cherryPickElement).focus();
        }
      },
    ];
    tabs.forEach(({ ele, cb }, i) => {
      ele.addEventListener("click", () => {
        ele.classList.add("ehvp-p-tab-selected")
        tabs.filter((_, j) => j != i).forEach(t => t.ele.classList.remove("ehvp-p-tab-selected"));
        cb();
      });
    });
  }

  switchTab(tabID: TabID) {
    switch (tabID) {
      case "status":
        this.tabStatus.click();
        break;
      case "chapters":
        this.tabChapters.click();
        break;
      case "cherry-pick":
        this.tabCherryPick.click();
        break;
    }
  }

  initNotice(btns: { btn: string, tooltip?: string, cb: () => void }[]) {
    this.noticeElement.innerHTML = "";
    btns.forEach(b => {
      // <a class='clickable' style='color:gray;'>Enable RawImage Transient</a>
      const a = document.createElement("a");
      a.textContent = b.btn;
      a.classList.add("clickable");
      a.style.color = "gray";
      a.style.margin = "0em 0.5em";
      a.addEventListener("click", b.cb);
      this.noticeElement.append(a);
    });
  }

  abort(stage: "downloadFailed" | "downloaded" | "downloadStart") {
    this.flushUI(stage);
    this.normalizeBTN();
  }

  flushUI(stage: "downloadFailed" | "downloaded" | "downloading" | "downloadStart" | "packaging") {
    const locked = stage === "downloading" || stage === "packaging";
    this.cherryPickElement.setAttribute("aria-busy", String(locked));
    this.cherryPickElement.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button").forEach(control => control.disabled = locked);
    this.startBTN.style.color = stage === "downloadFailed" ? "red" : "";
    this.startBTN.textContent = i18n[stage].get();
    this.btn.style.color = stage === "downloadFailed" ? "red" : "";
  }

  noticeableBTN() {
    if (!this.btn.classList.contains("lightgreen")) {
      this.btn.classList.add("lightgreen");
      if (!/✓/.test(this.btn.textContent!)) {
        this.btn.textContent += "✓";
      }
    }
  }

  normalizeBTN() {
    this.btn.textContent = this.btn.textContent!.replace("✓", "");
    this.btn.classList.remove("lightgreen");
  }

  createChapterSelectList(chapters: Chapter[], selectedChapters: ChapterStat[]) {
    const selectAll = chapters.length === 1;
    this.chaptersElement.innerHTML = `
      <div>
        <span id="download-chapters-select-all" class="clickable">Select All</span>
        <span id="download-chapters-unselect-all" class="clickable">Unselect All</span>
        <span id="download-chapters-add-new" class="clickable">Add New Chapters</span>
      </div>
      ${chapters.map((c, i) => `<div><label>
        <input type="checkbox" id="ch-${c.id}" value="${c.id}" ${selectAll || selectedChapters.find(sel => sel.index === i) ? "checked" : ""} />
        <span>${c.title}</span></label></div>`).join("")}`;

    ([["#download-chapters-select-all", true], ["#download-chapters-unselect-all", false]] as [string, boolean][]).forEach(([id, checked]) =>
      this.chaptersElement.querySelector<HTMLElement>(id)?.addEventListener("click", () =>
        chapters.forEach(c => {
          const checkbox = this.chaptersElement.querySelector<HTMLInputElement>("#ch-" + c.id);
          if (checkbox) checkbox.checked = checked;
        })
      )
    );
    this.chaptersElement.querySelector<HTMLElement>("#download-chapters-add-new")?.addEventListener("click", (event) => {
      function modal(root: HTMLElement, target: HTMLElement, inner: string, onComfirm: (div: HTMLDivElement) => Promise<void>) {
        const div = document.createElement("div");
        div.style.position = "fixed";
        div.style.zIndex = "2100";
        div.style.padding = "3px";
        div.style.backgroundColor = "var(--ehvp-theme-bg-color)";
        div.style.border = "var(--ehvp-panel-border)";
        div.style.borderRadius = "5px";
        div.innerHTML = `
          <div style="display: flex; justify-content: center; margin: 10px 2px;">${inner}</div>
          <div style="display: flex; justify-content: center;">
            <button class="ehvp-custom-btn ehvp-modal-btn-cancel" style="background-color: gray;">Cancel</button>
            <button class="ehvp-custom-btn ehvp-modal-btn-confirm" style="background-color: var(--ehvp-clickable-color-hover);">Confirm</button>
          </div>
        `;
        root.appendChild(div);
        div.querySelector<HTMLButtonElement>(".ehvp-modal-btn-cancel")?.addEventListener("click", () => div.remove());
        div.querySelector<HTMLButtonElement>(".ehvp-modal-btn-confirm")?.addEventListener("click", () => onComfirm(div).finally(() => div.remove()));
        relocateElement(div, target, root.offsetWidth, root.offsetHeight);
      }
      modal(this.root, event.target as HTMLElement,
        `<input id="download-chapters-add-input" style="width: 250px; background-color: #ffffff80;" placeholder="https://example.com" />`,
        async (div) => {
          const value = div.querySelector<HTMLInputElement>("#download-chapters-add-input")?.value;
          if (!value) return;
          const future = EBUS.emit("pf-append-chapters", value);
          if (future) await future;
          // this.createChapterSelectList
        });
    });
  }

  selectedChapters() {
    const idSet = new Set<number>();
    this.chaptersElement.querySelectorAll<HTMLInputElement>("input[type=checkbox][id^=ch-]:checked")
      .forEach(checkbox => idSet.add(Number(checkbox.value)));
    return idSet;
  }

  initCherryPick(getPick: (chapterIndex: number) => CherryPick, onChange: (chapterIndex: number) => void, downloading: () => boolean) {
    let chapterIndex = 0;
    let draft = false;
    const totals = new Map<number, { total: number, done: boolean }>();
    const lastIndices = new Map<number, number>();
    const ranges = q<HTMLElement>("#download-cherry-pick-values", this.cherryPickElement);
    const input = q<HTMLInputElement>("#download-cherry-pick-input", this.cherryPickElement);
    const ruleInput = q<HTMLInputElement>("#download-rule-input", this.cherryPickElement);
    const preset = q<HTMLSelectElement>("#download-rule-preset", this.cherryPickElement);
    const preview = q<HTMLElement>("#download-rule-preview", this.cherryPickElement);
    const error = q<HTMLElement>("#download-rule-error", this.cherryPickElement);
    const rangeBefore = q<HTMLElement>("#download-cherry-pick-btn-range-before", this.cherryPickElement);
    const rangeAfter = q<HTMLElement>("#download-cherry-pick-btn-range-after", this.cherryPickElement);
    const locked = () => downloading() || this.cherryPickElement.getAttribute("aria-busy") === "true";

    const updatePreview = () => {
      const { total, done } = totals.get(chapterIndex) ?? { total: 0, done: false };
      let pick = getPick(chapterIndex);
      let invalid = false;
      if (draft) {
        const candidate = new CherryPick();
        if (!candidate.applyRule(ruleInput.value)) {
          error.textContent = i18n.ruleInvalid.get();
          ruleInput.setAttribute("aria-invalid", "true");
          invalid = true;
        } else {
          pick = candidate;
        }
      }
      if (!invalid) {
        error.textContent = "";
        ruleInput.removeAttribute("aria-invalid");
      }
      const result = pick.preview(total);
      preview.textContent = (draft && !invalid ? i18n.ruleDraft.get() + ": " : "") +
        i18n.rulePreview.get().replace("{count}", String(result.count)).replace("{total}", String(total)) +
        (result.pages.length ? `: ${result.pages.join(", ")}${result.count > result.pages.length ? "…" : ""}` : "") +
        (done ? "" : " · " + i18n.ruleLoading.get());
    };
    const syncRule = () => {
      draft = false;
      ruleInput.value = getPick(chapterIndex).rule?.toString() ?? "";
      preset.value = Array.from(preset.options).some(option => option.value === ruleInput.value) ? ruleInput.value : "custom";
      updatePreview();
    };
    const renderRanges = () => {
      ranges.replaceChildren();
      for (const range of getPick(chapterIndex).values) {
        const tag = document.createElement("span");
        tag.className = "ehvp-custom-panel-item-value";
        tag.style.backgroundColor = range.positive ? "#7fef7b" : "#ffa975";
        const label = document.createElement("span");
        label.textContent = range.toString();
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `${range.toString()} ×`);
        remove.disabled = locked();
        remove.addEventListener("click", () => {
          if (locked()) return;
          getPick(chapterIndex).remove(range.id);
          onChange(chapterIndex);
        });
        tag.append(label, remove);
        ranges.appendChild(tag);
      }
    };
    const addRange = (exclude: boolean, raw = input.value, replace = false) => {
      if (locked()) return;
      const parsed = raw.split(/[,，]/).map(value => CherryPickRange.from((exclude ? "!" : "") + value.trim()));
      if (parsed.some(range => range === null)) {
        error.textContent = i18n.rangeInvalid.get();
        return;
      }
      if (replace) getPick(chapterIndex).reset();
      parsed.forEach(range => getPick(chapterIndex).add(range!));
      input.value = "";
      draft = false;
      onChange(chapterIndex);
      input.focus();
    };
    const clear = () => {
      if (locked()) return;
      getPick(chapterIndex).reset();
      input.value = "";
      onChange(chapterIndex);
    };
    const applyRule = () => {
      if (locked()) return;
      if (!getPick(chapterIndex).applyRule(ruleInput.value)) {
        error.textContent = i18n.ruleInvalid.get();
        ruleInput.setAttribute("aria-invalid", "true");
        return;
      }
      onChange(chapterIndex);
    };
    q("#download-rule-apply", this.cherryPickElement).addEventListener("click", applyRule);
    ruleInput.addEventListener("input", () => {
      draft = true;
      preset.value = "custom";
      updatePreview();
    });
    preset.addEventListener("change", () => {
      if (preset.value === "custom") { ruleInput.focus(); return; }
      ruleInput.value = preset.value;
      draft = true;
      updatePreview();
    });
    q("#download-cherry-pick-btn-add", this.cherryPickElement).addEventListener("click", () => addRange(false));
    q("#download-cherry-pick-btn-exclude", this.cherryPickElement).addEventListener("click", () => addRange(true));
    q("#download-cherry-pick-btn-clear", this.cherryPickElement).addEventListener("click", clear);
    for (const field of [ruleInput, input, preset]) {
      field.addEventListener("keydown", event => {
        event.stopPropagation();
        if ((event as KeyboardEvent).key === "Enter" && field !== preset) {
          event.preventDefault();
          if (field === ruleInput) applyRule(); else addRange(false);
        }
      });
      field.addEventListener("keypress", event => event.stopPropagation());
      field.addEventListener("keyup", event => event.stopPropagation());
    }
    this.cherryPickElement.querySelectorAll<HTMLElement>(".download-cherry-pick-follow-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (locked()) return;
        const exclude = btn.getAttribute("data-sibling-step") === "2";
        const sibling = exclude ? btn.previousElementSibling!.previousElementSibling! : btn.previousElementSibling!;
        addRange(exclude, sibling.getAttribute("data-range") || "", !exclude);
      });
    });
    EBUS.subscribe("add-cherry-pick-range", (index, page, positive, shift) => {
      if (locked() || index < 0) return;
      const last = lastIndices.get(index) ?? page;
      getPick(index).add(new CherryPickRange([page + 1, (shift ? last : page) + 1], positive));
      if (!shift) lastIndices.set(index, page);
      onChange(index);
    });
    EBUS.subscribe("get-cherry-pick-last-index", () => lastIndices.get(chapterIndex) ?? 0);
    EBUS.subscribe("cherry-pick-changed", index => {
      if (index !== chapterIndex) return;
      renderRanges();
      syncRule();
    });
    EBUS.subscribe("pf-change-chapter", (index, chapter) => {
      if (index < 0) return;
      chapterIndex = index;
      input.value = "";
      totals.set(index, { total: chapter.filteredQueue.length, done: !!chapter.done });
      renderRanges();
      syncRule();
    });
    EBUS.subscribe("pf-on-appended", (total, _nodes, index, done) => {
      totals.set(index, { total, done: !!done });
      if (index !== chapterIndex) return;
      const current = Math.min((lastIndices.get(index) ?? 0) + 1, total);
      rangeBefore.textContent = `${current}-${total}`;
      rangeBefore.setAttribute("data-range", rangeBefore.textContent);
      updatePreview();
    });
    EBUS.subscribe("ifq-do", index => {
      const total = totals.get(chapterIndex)?.total ?? 0;
      rangeAfter.textContent = `1-${index + 1}`;
      rangeAfter.setAttribute("data-range", rangeAfter.textContent);
      rangeBefore.textContent = `${index + 1}-${total}`;
      rangeBefore.setAttribute("data-range", rangeBefore.textContent);
    });
    syncRule();
  }


  static html() {
    return `
<div id="downloader-panel" class="p-panel p-downloader p-collapse">
    <div id="download-notice" class="download-notice" style="font-size: 0.7em;"></div>
    <div id="download-middle" class="download-middle">
      <div class="ehvp-tabs">
        <a id="download-tab-status" class="clickable ehvp-p-tab">${i18n.status.get()}</a>
        <a id="download-tab-cherry-pick" class="clickable ehvp-p-tab">${i18n.cherryPick.get()}</a>
        <a id="download-tab-chapters" class="clickable ehvp-p-tab">${i18n.selectChapters.get()}</a>
      </div>
      <div>
        <div id="download-status" class="download-status" hidden>
          <canvas id="downloader-canvas" width="0" height="0"></canvas>
        </div>
        <div id="download-cherry-pick" class="download-cherry-pick" hidden>
          <div class="ehvp-custom-panel-item-values" style="text-align: start;">
            <div class="download-rule-controls">
              <label for="download-rule-preset">${i18n.ruleSelection.get()}</label>
              <select id="download-rule-preset">
                <option value="">${i18n.ruleAll.get()}</option>
                <option value="2n+1">${i18n.ruleOdd.get()}</option>
                <option value="2n">${i18n.ruleEven.get()}</option>
                <option value="3n+1">${i18n.ruleThird.get()}</option>
                <option value="custom">${i18n.ruleCustom.get()}</option>
              </select>
              <input type="text" id="download-rule-input" placeholder="2n+1" aria-label="${i18n.ruleCustom.get()}" aria-describedby="download-rule-help download-rule-error" autocomplete="off" spellcheck="false" />
              <button type="button" id="download-rule-apply" class="ehvp-custom-btn ehvp-custom-btn-green">${i18n.ruleApply.get()}</button>
            </div>
            <p id="download-rule-help" class="download-rule-help">${i18n.ruleHelp.get()}</p>
            <div id="download-rule-preview" role="status" aria-live="polite"></div>
            <div id="download-rule-error" role="alert"></div>
            <div style="margin-bottom: 1rem;display: flex;">
              <input type="text" class="ehvp-custom-panel-item-input" id="download-cherry-pick-input" placeholder="1, 2-3" style="text-align: start; width: 50%; height: 1.3rem; border-radius: 0px;" />
              <span class="ehvp-custom-btn ehvp-custom-btn-green" id="download-cherry-pick-btn-add">Pick</span>
              <span class="ehvp-custom-btn ehvp-custom-btn-plain" id="download-cherry-pick-btn-exclude">Exclude</span>
              <span class="ehvp-custom-btn ehvp-custom-btn-plain" id="download-cherry-pick-btn-clear">Clear</span>
            </div>
            <div id="download-cherry-pick-values"></div>
            <div style="margin-bottom: 1rem;">
              <div style="margin-bottom: 0.2rem">
                <span class="ehvp-custom-panel-item-span" id="download-cherry-pick-btn-range-after" data-range="1-1">1-1</span><span
                 class="ehvp-custom-btn ehvp-custom-btn-green download-cherry-pick-follow-btn" data-sibling-step="1">pick</span><span
                 class="ehvp-custom-btn ehvp-custom-btn-plain download-cherry-pick-follow-btn" data-sibling-step="2">exclude</span>
              </div>
              <div>
                <span class="ehvp-custom-panel-item-span" id="download-cherry-pick-btn-range-before" data-range="1-1">1-1</span><span
                class="ehvp-custom-btn ehvp-custom-btn-green download-cherry-pick-follow-btn" data-sibling-step="1">pick</span><span
                class="ehvp-custom-btn ehvp-custom-btn-plain download-cherry-pick-follow-btn" data-sibling-step="2">exclude</span>
              </div>
            </div>
          </div>
        </div>
        <div id="download-chapters" class="download-chapters" hidden></div>
      </div>
    </div>
    <div class="download-btn-group">
       <a id="download-force" class="clickable">${i18n.forceDownload.get()}</a>
       <a id="download-start" style="color: rgb(120, 240, 80)" class="clickable">${i18n.downloadStart.get()}</a>
    </div>
</div>`;
  }
}


import { FetchState, IMGFetcher } from "../img-fetcher";
import { IMGFetcherQueue } from "../fetcher-queue";
import { IdleLoader } from "../idle-loader";
import { Matcher, SubData } from "../platform/platform";
import { GalleryMeta } from "./gallery-meta";
import { Elements } from "../ui/html";
import { FileLike, Zip } from "../utils/zip-stream";
import { saveAs } from "file-saver";
import EBUS from "../event-bus";
import { DownloaderCanvas } from "../ui/downloader-canvas";
import { Chapter, PageFetcher } from "../page-fetcher";
import { evLog } from "../utils/ev-log";
import { DownloaderPanel } from "../ui/downloader-panel";
import { i18n } from "../utils/i18n";
import { ADAPTER } from "../platform/adapt";
import { generateConvertScript } from "../utils/ffmpeg";
import { CherryPick } from "./cherry-pick";
import { sleep } from "../utils/sleep";

const FILENAME_INVALIDCHAR = /[\\/:*?"<>|\n\t]/g;
export class Downloader {
  meta: (chapter: Chapter) => GalleryMeta;
  title: (chapters: Chapter[]) => string;
  downloading: boolean;
  queue: IMGFetcherQueue;
  idleLoader: IdleLoader;
  pageFetcher: PageFetcher;
  done: boolean = false;
  selectedChapters: ChapterStat[] = [];
  filenames: Set<string> = new Set();
  panel: DownloaderPanel;
  canvas: DownloaderCanvas;
  cherryPicks: CherryPick[] = [new CherryPick()];
  private downloadRun = 0;

  constructor(HTML: Elements, queue: IMGFetcherQueue, idleLoader: IdleLoader, pageFetcher: PageFetcher, matcher: Matcher<any>) {
    this.panel = HTML.downloader;
    this.panel.initTabs();
    this.initEvents(this.panel);
    this.panel.initCherryPick(
      chapterIndex => this.getCherryPick(chapterIndex),
      chapterIndex => EBUS.emit("cherry-pick-changed", chapterIndex, this.getCherryPick(chapterIndex)),
      () => this.downloading
    );
    this.panel.initNotice([
      {
        btn: i18n.resetDownloaded.get(),
        cb: () => {
          if (confirm(i18n.resetDownloadedConfirm.get())) this.queue.forEach(imf => (imf.stage === FetchState.DONE) && imf.resetStage());
        }
      },
      {
        btn: i18n.resetFailed.get(),
        cb: () => {
          this.queue.forEach(imf => (imf.stage === FetchState.FAILED) && imf.resetStage());
          if (!this.downloading) this.idleLoader.abort(0, 100);
        }
      }
    ]);
    this.queue = queue;
    this.queue.cherryPick = chapterIndex => this.getCherryPick(chapterIndex);
    this.idleLoader = idleLoader;
    this.idleLoader.cherryPick = () => this.cherryPicks[this.queue.chapterIndex] || new CherryPick();
    this.canvas = new DownloaderCanvas(this.panel.canvas, queue, () => this.cherryPicks[this.queue.chapterIndex] || new CherryPick());
    this.pageFetcher = pageFetcher;
    this.meta = (chapter: Chapter) => matcher.galleryMeta(chapter);
    this.title = (chapters: Chapter[]) => matcher.title(chapters);
    this.downloading = false;
    this.queue.downloading = () => this.downloading;

    EBUS.subscribe("ifq-on-finished-report", (_, queue) => {
      if (queue.isFinished()) {
        if (!this.downloading && !this.done) {
          this.panel.noticeableBTN();
        }
      }
    });
    EBUS.subscribe("imf-check-picked", (chapterIndex, index) => this.cherryPicks[chapterIndex]?.picked(index));
  }

  getCherryPick(chapterIndex: number): CherryPick {
    return this.cherryPicks[chapterIndex] ??= new CherryPick();
  }

  initEvents(panel: DownloaderPanel) {
    panel.forceBTN.addEventListener("click", () => this.download(this.pageFetcher.chapters));
    panel.startBTN.addEventListener("click", () => {
      if (this.downloading) {
        this.abort("downloadStart");
      } else {
        this.start();
      }
    });
  }

  needNumberTitle(queue: IMGFetcher[]): boolean {
    if (ADAPTER.conf.filenameOrder === "numbers") return true;
    if (ADAPTER.conf.filenameOrder === "original") return false;
    let comparer;
    if (ADAPTER.conf.filenameOrder === "alphabetically") {
      comparer = (a: string, before: string) => a < before;
    } else {
      comparer = (a: string, before: string) => a.localeCompare(before, undefined, { numeric: true, sensitivity: 'base' }) < 0;
    }
    let lastTitle = "";
    for (const fetcher of queue) {
      if (lastTitle && comparer(fetcher.node.title, lastTitle)) {
        return true;
      }
      lastTitle = fetcher.node.title;
    }
    return false;
  }


  // check > start > download
  check() {
    if (this.downloading) return;
    setTimeout(() => EBUS.emit("downloader-canvas-resize"), 110);
    this.panel.createChapterSelectList(this.pageFetcher.chapters, this.selectedChapters);
    if (this.queue.length > 0) {
      this.panel.switchTab("status");
    } else if (this.pageFetcher.chapters.length > 1) {
      this.panel.switchTab("chapters");
    }
  }

  checkSelectedChapters() {
    this.selectedChapters.length = 0;
    const idSet = this.panel.selectedChapters();
    if (idSet.size === 0) {
      this.selectedChapters.push({ index: this.pageFetcher.chapterIndex, done: false });
    } else {
      this.pageFetcher.chapters.forEach((c, i) => idSet.has(c.id) && this.selectedChapters.push({ index: i, done: false }));
    }
    // evLog("debug", "get selected chapters: ", this.selectedChapters);
    return this.selectedChapters;
  }

  async start() {
    if (this.downloading) return;
    const run = ++this.downloadRun;
    const active = () => this.downloading && this.downloadRun === run;
    this.done = false;
    this.downloading = true;
    this.idleLoader.abort();
    this.panel.flushUI("downloading");
    this.checkSelectedChapters();
    try {
      for (const sel of this.selectedChapters) {
        if (!active()) return;
        await this.pageFetcher.restoreChapter(sel.index);
        if (!active()) return;
        this.queue.forEach(imf => imf.stage === FetchState.FAILED && imf.resetStage());
        await this.loadChapter(sel.index, active);
        if (!active()) return;
        sel.done = true;
      }
      const chapters = this.selectedChapters.filter(sel => sel.done).map(sel => this.pageFetcher.chapters[sel.index]);
      const hasSelection = this.selectedChapters.some(sel => this.pageFetcher.chapters[sel.index].filteredQueue.some((_, i) => this.getCherryPick(sel.index).picked(i)));
      if (!hasSelection) throw new Error(i18n.ruleNoMatches.get());
      if (active()) await this.download(chapters);
    } catch (error) {
      if (!active()) return;
      this.abort("downloadFailed");
      EBUS.emit("notify-message", "error", String(error));
      evLog("error", "download failed: ", error);
    } finally {
      if (this.downloadRun === run) this.downloading = false;
    }
  }

  /** Drain selected images with bounded workers, then discover the next list page.
   * Empty matching batches still advance the iterator; only its end completes a chapter. */
  async loadChapter(chapterIndex: number, active: () => boolean): Promise<void> {
    const picked = this.getCherryPick(chapterIndex);
    const chapter = this.pageFetcher.chapters[chapterIndex];
    const threads = Math.max(1, Math.floor(ADAPTER.conf.downloadThreads));
    let cursor = 0;
    while (active()) {
      let failed = false;
      const worker = async () => {
        while (active() && !failed) {
          if (cursor >= this.queue.length) return;
          const index = cursor++;
          if (!picked.picked(index)) continue;
          const imf = this.queue[index];
          // A request started by the reader may still be in flight.
          while (imf.lock && active() && !failed) await sleep(25);
          if (!active() || failed) return;
          if (imf.stage === FetchState.DONE) continue;
          try {
            await imf.start();
            if ((imf.stage as FetchState) !== FetchState.DONE) throw new Error(imf.failedReason || `Image ${index + 1} failed`);
          } catch (error) {
            failed = true;
            throw error;
          }
          if (active() && !failed && cursor < this.queue.length) await this.idleLoader.wait();
        }
      };
      // Wait for every in-flight worker before reporting failure or switching chapters.
      const results = await Promise.allSettled(Array.from({ length: threads }, worker));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      if (!active() || chapter.done) return;
      const appended = await this.pageFetcher.appendNextPage(undefined, true);
      if (!appended && !chapter.done) throw new Error("Unable to load the next list page");
    }
  }

  mapToFileLikes(chapter: Chapter, picked: CherryPick, directory: string): FileLike[] {
    if (!chapter || chapter.filteredQueue.length === 0) return [];
    // const SEP = navigator.userAgent.indexOf("Win") !== -1 ? "/" : "/";
    const SEP = "/"; // this is ok
    let checkTitle: (title: string, index: number) => string;
    const needNumberTitle = this.needNumberTitle(chapter.filteredQueue);
    if (needNumberTitle) {
      const digits = chapter.filteredQueue.length.toString().length;
      if (ADAPTER.conf.filenameOrder === "numbers") {
        checkTitle = (title: string, index: number) => `${index + 1}`.padStart(digits, "0") + "." + title.split(".").pop();
      } else {
        checkTitle = (title: string, index: number) => `${index + 1}`.padStart(digits, "0") + "_" + title.replaceAll(FILENAME_INVALIDCHAR, "_");
      }
    } else {
      this.filenames.clear();
      checkTitle = (title: string) => deduplicate(this.filenames, title.replaceAll(FILENAME_INVALIDCHAR, "_"));
    }
    const fQueue = chapter.filteredQueue.filter((imf, i) => picked.picked(i) && imf.stage === FetchState.DONE && imf.data);
    const ret = [];

    let needConvertScript = false;
    for (let i = 0; i < fQueue.length; i++) {
      const imf = fQueue[i];
      if (imf.data instanceof SubData) {
        const subDirectory = checkTitle(imf.node.title, i);
        if (subDirectory.includes("ugoira0")) {
          needConvertScript = true;
        }
        for (const sd of imf.data.list) {
          const data = sd.data;
          const size = data.byteLength;
          const name = sd.name.replaceAll(FILENAME_INVALIDCHAR, "_");
          const file = {
            stream: () => Promise.resolve(uint8ArrayToReadableStream(data)),
            size: () => size,
            name: directory + (directory === "" ? "" : SEP) + subDirectory + SEP + name,
          };
          ret.push(file);
        }
      } else if (imf.data instanceof Uint8Array) {
        const data = imf.data;
        const size = imf.data.byteLength;
        const file = {
          stream: () => Promise.resolve(uint8ArrayToReadableStream(data)),
          size: () => size,
          name: directory + (directory === "" ? "" : SEP) + checkTitle(imf.node.title, i)
        };
        ret.push(file);
      }
    }
    // gallery meta
    const meta = new TextEncoder().encode(JSON.stringify(this.meta(chapter), null, 2));
    ret.push({
      stream: () => Promise.resolve(uint8ArrayToReadableStream(meta)),
      size: () => meta.byteLength,
      name: directory + (directory === "" ? "" : SEP) + "meta.json"
    });
    if (needConvertScript) {
      const scripts = generateConvertScript();
      scripts.forEach((sc, i) => {
        const r = new TextEncoder().encode(sc);
        ret.push({
          stream: () => Promise.resolve(uint8ArrayToReadableStream(r)),
          size: () => r.byteLength,
          name: directory + (directory === "" ? "" : SEP) + "convert_to_gif." + (i === 0 ? "sh" : "bat"),
          unixPermissions: "755",
        });
      })

    }
    return ret;
  }

  async download(chapters: Chapter[]) {
    try {
      const archiveName = this.title(chapters).replaceAll(FILENAME_INVALIDCHAR, "_");
      const singleChapter = chapters.length === 1;
      this.panel.flushUI("packaging");
      const dirnameSet = new Set<string>();
      const files: FileLike[] = [];
      for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i];
        const chapterIndex = this.pageFetcher.chapters.indexOf(chapter);
        const picked = this.getCherryPick(chapterIndex);
        let directory = (() => {
          if (singleChapter) return "";
          if (chapter.title instanceof Array) {
            return chapter.title.join("_").replaceAll(FILENAME_INVALIDCHAR, "_").replaceAll(/\s+/g, " ");
          } else {
            return chapter.title.replaceAll(FILENAME_INVALIDCHAR, "_").replaceAll(/\s+/g, " ");
          }
        })();
        directory = shrinkFilename(directory, 200);
        directory = deduplicate(dirnameSet, directory);
        const ret = this.mapToFileLikes(chapter, picked, directory);
        files.push(...ret);
      }
      const zip = new Zip({ volumeSize: 1024 * 1024 * (ADAPTER.conf.archiveVolumeSize || 1500) });
      // const zip = new Zip({ volumeSize: 1024 * 1024 * 4000 });
      // for (let i = 0; i < 50; i++) {
      //   const buffer = new ArrayBuffer(100 * 1024 * 1024);
      //   const chunk = new Uint8Array(buffer);
      //   zip.add({
      //     stream: () => Promise.resolve(uint8ArrayToReadableStream(chunk)),
      //     size: () => chunk.byteLength,
      //     name: (i + 1) + ".jpg",
      //   });
      // }
      files.forEach((file) => zip.add(file));
      const save = async () => {
        let readable;
        while (readable = zip.nextReadableStream()) {
          const blob = await new Response(readable).blob();
          const ext = zip.currVolumeNo === zip.volumes - 1 ?
            "zip" :
            "z" + (zip.currVolumeNo + 1).toString().padStart(2, "0");
          // TODO: chromium support writeableStream https://developer.chrome.com/docs/capabilities/web-apis/file-system-access#write-file
          saveAs(blob, `${archiveName}.${ext}`);
        }
      }
      await save();
      this.done = true;
    } catch (error: any) {
      let reason = error.toString() as string;
      if (reason.includes(`autoAllocateChunkSize`)) {
        reason = "Create Zip archive prevented by The content security policy of this page. Please refer to the CONF > Help for a solution.";
      }
      EBUS.emit("notify-message", "error", `packaging failed, ${reason}`);
      throw error;
    } finally {
      this.abort(this.done ? "downloaded" : "downloadFailed");
    }
  }

  abort(stage: "downloadFailed" | "downloaded" | "downloadStart") {
    this.downloading = false;
    this.downloadRun++;
    this.panel.abort(stage);
    this.idleLoader.abort();
  }
}

function shrinkFilename(str: string, limit: number): string {
  const encoder = new TextEncoder();
  const byteLen = (s: string) => encoder.encode(s).byteLength;
  const bLen = byteLen(str);
  if (bLen <= limit) return str;
  const sliceRange = [str.length >> 1, (str.length >> 1) + 1]
  let left = true;
  while (true) {
    if (bLen - byteLen(str.slice(...sliceRange)) <= limit) {
      return str.slice(0, sliceRange[0]) + ",,," + str.slice(sliceRange[1]);
    }
    if (left && sliceRange[0] > 3) {
      sliceRange[0] -= 1;
      left = false;
      continue;
    }
    if (sliceRange[1] < str.length - 3) {
      sliceRange[1] += 1;
      left = true;
      continue;
    }
    break;
  }
  return str.slice(0, limit);
}

function deduplicate(set: Set<string>, title: string): string {
  let newTitle = title;
  if (set.has(newTitle)) {
    const splits = newTitle.split(".");
    const ext = splits.pop();
    const prefix = splits.join(".");
    const num = parseInt(prefix.match(/_(\d+)$/)?.[1] || "");
    if (isNaN(num)) {
      newTitle = `${prefix}_1.${ext}`;
    } else {
      newTitle = `${prefix.replace(/\d+$/, (num + 1).toString())}.${ext}`;
    }
    return deduplicate(set, newTitle);
  } else {
    set.add(newTitle);
    return newTitle;
  }
}

function uint8ArrayToReadableStream(arr: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(arr);
      controller.close();
    }
  });
}

export type ChapterStat = {
  index: number,
  done: boolean,
};

export { CherryPick, CherryPickRange } from "./cherry-pick";

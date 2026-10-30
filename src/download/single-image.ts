import { saveAs } from "file-saver";
import { FetchState, IMGFetcher } from "../img-fetcher";
import { SubData } from "../platform/platform";
import { i18n } from "../utils/i18n";
import { sleep } from "../utils/sleep";

const formats: Record<string, string[]> = {
  "image/jpeg": ["jpg", "jpeg", "jpe"], "image/png": ["png"],
  "image/gif": ["gif"], "image/webp": ["webp"], "image/avif": ["avif"],
  "image/bmp": ["bmp"], "image/jxl": ["jxl"], "image/svg+xml": ["svg"],
  "image/tiff": ["tif", "tiff"], "image/x-icon": ["ico"],
  "image/heic": ["heic"], "image/heif": ["heif"], "image/apng": ["apng"],
};
const pending = new WeakMap<IMGFetcher, Promise<void>>();

export function canDownloadSingleImage(imf: IMGFetcher): boolean {
  const mime = (imf.contentType || imf.node.mimeType || "").toLowerCase().split(";")[0].trim();
  return !(imf.data instanceof SubData) && (!mime || mime.startsWith("image/") || mime === "application/octet-stream");
}

function fileInfo(imf: IMGFetcher): { name: string, mime: string } {
  let name = imf.node.title?.trim();
  if (!name && imf.node.originSrc) {
    try { name = decodeURIComponent(new URL(imf.node.originSrc).pathname.split("/").pop() || ""); } catch { /* use the page number */ }
  }
  name = (name || `image-${imf.index + 1}`).replace(/[\x00-\x1f\\/:*?"<>|]/g, "_").replace(/^[. ]+|[. ]+$/g, "");
  if (!name) name = `image-${imf.index + 1}`;
  const extension = name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  let mime = (imf.contentType || imf.node.mimeType || "").toLowerCase().split(";")[0].trim();
  if (mime === "image/jpg" || mime === "image/pjpeg") mime = "image/jpeg";
  if (!mime.startsWith("image/")) mime = Object.keys(formats).find(key => extension && formats[key].includes(extension)) || "";
  if (!mime) throw new Error(i18n.singleImageUnsupported.get());
  const extensions = formats[mime];
  if (extensions && (!extension || !extensions.includes(extension))) {
    name = name.replace(/\.[a-z0-9]+$/i, "") + "." + extensions[0];
  } else if (!extensions && (extension === "zip" || extension === "rar" || extension === "7z")) {
    name = name.replace(/\.[a-z0-9]+$/i, ".img");
  } else if (!extension) {
    name += ".img";
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = "_" + name;
  return { name, mime };
}

async function saveImage(imf: IMGFetcher): Promise<void> {
  if (!canDownloadSingleImage(imf)) throw new Error(i18n.singleImageUnsupported.get());
  // Reuse an automatic/reader request already fetching this exact image.
  while (imf.lock) await sleep(25);
  if (imf.stage !== FetchState.DONE) await imf.start();
  if ((imf.stage as FetchState) !== FetchState.DONE || !imf.data) throw new Error(imf.failedReason || i18n.singleImageFailed.get());
  if (!canDownloadSingleImage(imf) || !(imf.data instanceof Uint8Array)) throw new Error(i18n.singleImageUnsupported.get());
  const { name, mime } = fileInfo(imf);
  saveAs(new Blob([imf.data], { type: mime }), name);
}

/** Save the captured image bytes directly, independently of the batch selection. */
export async function downloadSingleImage(imf: IMGFetcher): Promise<void> {
  const existing = pending.get(imf);
  if (existing) return existing;
  const request = saveImage(imf);
  pending.set(imf, request);
  try {
    await request;
  } finally {
    if (pending.get(imf) === request) pending.delete(imf);
  }
}

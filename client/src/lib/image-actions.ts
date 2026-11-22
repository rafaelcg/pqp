import { planImageCopy } from "@/lib/image-lightbox";

/**
 * Copying and saving an image, shared by the lightbox and the image's
 * right-click menu under the redesign, so both put the same bytes on the
 * clipboard and fall back the same way.
 */

async function convertToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("no 2d context");
    }
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error("toBlob failed"))),
        "image/png",
      );
    });
  } finally {
    bitmap.close?.();
  }
}

/**
 * The image itself on the clipboard, as a PNG. Throws when the browser cannot
 * write images or the bytes cannot be fetched; the caller decides what to
 * fall back to.
 */
export async function copyImageToClipboard(url: string, contentType: string): Promise<void> {
  const plan = planImageCopy(contentType);
  if (typeof navigator.clipboard?.write !== "function" || typeof ClipboardItem === "undefined") {
    throw new Error("Clipboard image writes unsupported");
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status}`);
  }
  const sourceBlob = await response.blob();
  const pngBlob = plan.needsConversion ? await convertToPng(sourceBlob) : sourceBlob;
  const items: Record<string, Blob> = { "image/png": pngBlob };
  if (plan.includeLinkText) {
    items["text/plain"] = new Blob([url], { type: "text/plain" });
  }
  await navigator.clipboard.write([new ClipboardItem(items)]);
}

/**
 * Saves the image under its own name. The presigned GET for an image is not
 * signed for a forced download (it has to render inline in the grid), and a
 * cross-origin bucket ignores the `download` attribute anyway, so when the
 * fetch fails opening it is the honest fallback rather than a download that
 * silently never starts.
 */
export async function downloadImage(url: string, filename: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`fetch failed: ${response.status}`);
    }
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

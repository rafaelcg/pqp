/**
 * Put text on the clipboard and say whether it really got there. The async
 * clipboard API is refused in an insecure frame, with the permission denied or
 * by a browser that never shipped it; the old `execCommand("copy")` on a
 * throwaway textarea still works from a tap in most of those. Only `true`
 * means the person can paste it: a caller that tells them "copied" must not do
 * so on `false`.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea.
  }
  if (typeof document === "undefined") {
    return false;
  }
  const area = document.createElement("textarea");
  try {
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

import type { Attachment } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const redesign = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/redesign", () => ({ useRedesign: () => redesign.on }));

const { AttachmentGrid } = await import("./attachment-grid");

function image(index: number): Attachment {
  return {
    id: `a${index}`,
    filename: `call-${index}.png`,
    contentType: "image/png",
    byteSize: 2048,
    width: 800,
    height: 600,
    url: `https://example.test/${index}.png`,
  } as Attachment;
}

const seven = [1, 2, 3, 4, 5, 6, 7].map(image);

describe("AttachmentGrid", () => {
  it("stacks every image with the toggle off", () => {
    redesign.on = false;
    const html = renderToStaticMarkup(<AttachmentGrid attachments={seven} />);
    expect(html).not.toContain("data-attachment-grid");
    expect(html.match(/<img /g)).toHaveLength(7);
  });

  it("shows four in the grid and counts the rest under the redesign", () => {
    redesign.on = true;
    const html = renderToStaticMarkup(<AttachmentGrid attachments={seven} />);
    expect(html).toContain("data-attachment-grid");
    expect(html.match(/<img /g)).toHaveLength(4);
    expect(html).toContain("+3");
  });

  it("keeps a single image out of the grid", () => {
    redesign.on = true;
    const html = renderToStaticMarkup(<AttachmentGrid attachments={[image(1)]} />);
    expect(html).not.toContain("data-attachment-grid");
    expect(html.match(/<img /g)).toHaveLength(1);
  });
});

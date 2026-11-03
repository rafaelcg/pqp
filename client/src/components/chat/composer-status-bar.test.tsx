import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COMPOSER_COUNT_FROM, ComposerStatusBar, textAsFile } from "./composer-status-bar";

function bar(length: number, onSendAsFile?: () => void) {
  return renderToStaticMarkup(
    <ComposerStatusBar typing={null} length={length} max={4000} flash={false} onSendAsFile={onSendAsFile} />,
  );
}

describe("ComposerStatusBar", () => {
  it("shows no count below the threshold", () => {
    expect(bar(COMPOSER_COUNT_FROM - 1)).not.toContain("data-composer-count");
  });

  it("shows a quiet count near the limit and a red one past it", () => {
    expect(bar(3900)).toContain('data-composer-count="near"');
    const over = bar(4200, () => {});
    expect(over).toContain('data-composer-count="over"');
    expect(over).toContain("text-danger");
  });

  it("offers the file only past the limit and only with a handler", () => {
    expect(bar(3900, () => {})).not.toContain("<button");
    expect(bar(4200)).not.toContain("<button");
    expect(bar(4200, () => {})).toContain("<button");
  });

  it("keeps the text intact in the file", async () => {
    const file = textAsFile("x".repeat(4200), "mensagem.txt");
    expect(file.type).toBe("text/plain");
    expect(await file.text()).toHaveLength(4200);
  });
});

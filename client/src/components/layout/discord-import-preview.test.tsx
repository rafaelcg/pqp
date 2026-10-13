import { renderToStaticMarkup } from "react-dom/server";
import { mapGuildTemplate, type DiscordImportPlan } from "@pqp/shared";
import { afterEach, describe, expect, it } from "vitest";
import { setActiveCatalogue } from "@/lib/i18n";
import { DiscordImportPreview } from "./discord-import-preview";

afterEach(() => setActiveCatalogue(undefined));

function planOf(forumChannels: boolean): DiscordImportPlan {
  return mapGuildTemplate(
    {
      serialized_source_guild: {
        name: "Guild",
        roles: [],
        channels: [
          { id: 1, type: 0, name: "general", position: 0, parent_id: null },
          {
            id: 2,
            type: 15,
            name: "questions",
            position: 1,
            parent_id: null,
            available_tags: [
              { name: "Bug", emoji_name: "🐛" },
              { name: "Official", moderated: true },
              ...Array.from({ length: 10 }, (_, i) => ({ name: `extra ${i}` })),
            ],
            default_sort_order: 1,
          },
        ],
      },
    },
    { forumChannels },
  );
}

describe("DiscordImportPreview forums", () => {
  it("draws a kept forum with the forum icon, its tags and the +N overflow", () => {
    const html = renderToStaticMarkup(
      <DiscordImportPreview plan={planOf(true)} snapshotLabel={null} />,
    );
    expect(html).toContain("lucide-messages-square");
    expect(html).toContain("questions");
    expect(html).toContain("Bug");
    // The emoji becomes the icon the import will store.
    expect(html).toContain('data-forum-tag-icon="bug"');
    // Eight chips, then "+4" for the other four of twelve.
    expect(html).toContain("+4");
    expect(html).not.toContain("extra 9");
    // The staff-only tag says so to a screen reader and on hover.
    expect(html).toContain("Official");
    expect(html).toContain("staff only");
    // The options that did not come along are listed, in plain words.
    expect(html).toContain("Some options on forum questions");
  });

  it("keeps drawing a flattened forum as a plain text channel", () => {
    const html = renderToStaticMarkup(
      <DiscordImportPreview plan={planOf(false)} snapshotLabel={null} />,
    );
    expect(html).not.toContain("lucide-messages-square");
    expect(html).toContain("Forum questions became a text channel");
  });
});

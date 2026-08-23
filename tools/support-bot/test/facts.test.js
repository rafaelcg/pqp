import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseFacts,
  loadFacts,
  harvestMeasurements,
  assertsE2E,
  splitSections,
  MAINTAINER_MARKER,
} from "../src/facts.js";

const FACTS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "facts.md");

function file(body) {
  return `${body}\n\n## nunca diga\n\n- nada\n\n## não sei\n\n- nada\n\n${MAINTAINER_MARKER}\n\n## manutenção\n\nnotas internas 999 fps`;
}

describe("parseFacts", () => {
  test("keeps only what is above the maintainer marker", () => {
    const facts = parseFacts(file("# T\n\nA captura é 1080p."));
    assert.match(facts.text, /1080p/);
    // The maintainer half is where the source-code references live. Sending it
    // would spend prompt tokens teaching the model about files no user asks
    // about, and would let a note become a fact.
    assert.doesNotMatch(facts.text, /notas internas/);
    assert.equal(facts.measurements.has("999fps"), false);
  });

  test("refuses a file with no marker rather than leaking the notes", () => {
    assert.throws(() => parseFacts("# T\n\n## nunca diga\n\n## não sei\n"), /marker/);
  });

  test("refuses a file missing a section the prompt names", () => {
    assert.throws(
      () => parseFacts(`# T\n\nalgo\n\n## nunca diga\n\n- x\n\n${MAINTAINER_MARKER}\n`),
      /não sei/,
    );
  });

  test("refuses a fact file that asserts end-to-end encryption", () => {
    assert.throws(
      () => parseFacts(file("As mensagens têm criptografia de ponta a ponta.")),
      /end-to-end/,
    );
  });

  test("allows the file to DENY end-to-end encryption, and to forbid the claim", () => {
    // Both of these contain the phrase. A check without a negation window
    // rejects the fact file for stating the fact correctly, which is what the
    // first version of this did.
    assert.ok(parseFacts(file("As mensagens não têm criptografia de ponta a ponta.")));
    assert.ok(
      parseFacts(file("Nunca diga que o pqp tem criptografia de ponta a ponta.")),
    );
  });
});

describe("harvestMeasurements", () => {
  test("collects numbers with units, normalising the decimal separator", () => {
    const found = harvestMeasurements("1080p a 30 quadros, teto de 2,5 Mbps e piso de 600 kbps");
    assert.ok(found.has("1080p"));
    assert.ok(found.has("2.5mbps"));
    assert.ok(found.has("600kbps"));
  });

  test("treats 2,5 Mbps and 2.5mbps as the same claim", () => {
    // Portuguese writes the decimal comma and the model will produce both.
    assert.deepEqual(
      [...harvestMeasurements("2,5 Mbps")],
      [...harvestMeasurements("2.5mbps")],
    );
  });

  test("does NOT learn a number from a section that forbids it", () => {
    // The bug this pins: `## nunca diga` contains "Nunca diga 4K", and a
    // harvest over the whole file learned 4k as an APPROVED measurement, so the
    // one number the facts explicitly ban became the one the screen allowed.
    const facts = parseFacts(
      `# T\n\nA captura é 1080p.\n\n## nunca diga\n\n- Nunca diga 4K.\n\n## não sei\n\n- nada\n\n${MAINTAINER_MARKER}\n`,
    );
    assert.ok(facts.measurements.has("1080p"));
    assert.equal(facts.measurements.has("4k"), false);
  });
});

describe("assertsE2E", () => {
  test("catches the claim however the verb is conjugated or spelled", () => {
    // The hole the first version shipped: it enumerated verbs, so a circumflex
    // on "têm" was enough to walk straight through the most important rule in
    // the system.
    for (const claim of [
      "as mensagens têm criptografia de ponta a ponta",
      "as mensagens tem criptografia de ponta a ponta",
      "é tudo end-to-end encrypted",
      "usamos E2EE aqui",
      "tudo com criptografia ponta a ponta",
    ]) {
      assert.equal(assertsE2E(claim), true, claim);
    }
  });

  test("permits the honest denial", () => {
    assert.equal(assertsE2E("não são criptografadas de ponta a ponta"), false);
    assert.equal(assertsE2E("o pqp não tem criptografia de ponta a ponta"), false);
    assert.equal(assertsE2E("nunca diga que tem criptografia de ponta a ponta"), false);
  });
});

describe("splitSections", () => {
  test("treats the preamble as affirmative", () => {
    const [first] = splitSections("um fato\n\n## nunca diga\n- x");
    assert.equal(first.heading, null);
    assert.match(first.body, /um fato/);
  });
});

describe("the real facts.md", () => {
  // The shipped file is content, and content is where this system fails. These
  // run against the actual file so a bad edit is a red test rather than a
  // wrong answer in the channel.
  const facts = loadFacts(FACTS_PATH);

  test("loads, and carries the sections the prompt refers to", () => {
    assert.ok(facts.headings.includes("nunca diga"));
    assert.ok(facts.headings.includes("não sei"));
  });

  test("contains no em dash", () => {
    // The house rule, applied to the file whose text is pasted into the prompt
    // and therefore into the model's idea of how this product writes.
    assert.doesNotMatch(facts.text, /[—–]/);
  });

  test("permits exactly the measurements the code actually implements", () => {
    assert.deepEqual(
      [...facts.measurements].sort(),
      ["1080p", "2.5mbps", "5mbps", "600kbps"],
    );
  });

  test("does not assert end-to-end encryption anywhere", () => {
    assert.equal(assertsE2E(facts.text), false);
  });

  test("is small enough to paste into every prompt", () => {
    // Roughly 1.5k tokens. The cost model in the README assumes this stays in
    // the same order of magnitude; a fact file that grows to 50KB is a
    // different product with a different bill.
    assert.ok(facts.text.length < 12_000, `facts.md is ${facts.text.length} chars`);
  });
});

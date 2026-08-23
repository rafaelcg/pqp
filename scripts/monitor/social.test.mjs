/**
 * The drift matcher, pinned.
 *
 * This is the one piece of the monitor with real branching logic rather than
 * "fetch a URL and look at the status code", and it is the piece with an
 * incident behind it: a published Reddit comment claiming screen share had no
 * audio, weeks after that stopped being true, found by chance.
 *
 * The asymmetry that shapes every case below: a FALSE NEGATIVE is a wrong claim
 * left standing in public, and a FALSE POSITIVE is one noisy alert. So the
 * patterns lean towards firing — but they must never fire on us telling the
 * truth, because an alert that cries wolf on an honest denial is an alert that
 * gets muted, and a muted alert is a false negative with extra steps.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { asserts, lastSegment, STALE_CLAIMS } from "./social.mjs";

const claim = (id) => {
  const found = STALE_CLAIMS.find((c) => c.id === id);
  if (!found) {
    throw new Error(`no claim named ${id}`);
  }
  return found;
};

describe("screen-share-has-no-audio — the claim that actually happened", () => {
  const c = claim("screen-share-has-no-audio");

  test("catches the English form that was published", () => {
    assert.ok(asserts("pqp screen share has no audio unfortunately", c));
    assert.ok(asserts("sadly there is no system audio when sharing", c));
  });

  test("catches the Portuguese forms", () => {
    assert.ok(asserts("compartilhamento de tela sem som", c));
    assert.ok(asserts("a tela compartilhada não leva áudio", c));
    assert.ok(asserts("não vai o som junto", c));
  });

  test("does NOT fire on the current, true statement", () => {
    // We say this constantly and correctly. Flagging it would train whoever
    // reads these alerts to stop reading them.
    assert.equal(
      asserts("o som vai junto se você compartilhar uma guia do chrome", c),
      null,
    );
    assert.equal(asserts("screen share carries audio from a Chrome tab", c), null);
  });
});

describe("claims-e2e", () => {
  const c = claim("claims-e2e");

  test("catches an assertion in either language or abbreviation", () => {
    assert.ok(asserts("the messages are end-to-end encrypted", c));
    assert.ok(asserts("tudo com criptografia de ponta a ponta", c));
    assert.ok(asserts("we use E2EE", c));
  });

  test("does NOT fire on the honest denial we are supposed to make", () => {
    assert.equal(asserts("messages are not end-to-end encrypted, it is a beta", c), null);
    assert.equal(asserts("não tem criptografia de ponta a ponta", c), null);
    assert.equal(asserts("there is no end-to-end encryption yet", c), null);
  });
});

describe("promises-app-store", () => {
  const c = claim("promises-app-store");

  test("catches a promise", () => {
    assert.ok(asserts("coming to the App Store soon", c));
    assert.ok(asserts("já está na App Store", c));
  });

  test("does NOT fire on the truthful denial", () => {
    // "It is not on the App Store" is a thing we should be able to say.
    assert.equal(asserts("it is not on the App Store, TestFlight only", c), null);
    assert.equal(asserts("não está na App Store", c), null);
  });
});

describe("the claim table itself", () => {
  test("every claim carries an id, a pattern and a why", () => {
    // `why` is shown in the alert. An alert that says "pattern 2 matched" is an
    // alert nobody acts on, so an entry without one is a bug.
    for (const c of STALE_CLAIMS) {
      assert.ok(c.id, "claim missing id");
      assert.ok(c.pattern instanceof RegExp, `${c.id}: pattern is not a RegExp`);
      assert.ok(c.why && c.why.length > 20, `${c.id}: why is missing or too short`);
    }
  });

  test("ids are unique, because the alert detail is keyed on them", () => {
    const ids = STALE_CLAIMS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});


test("lastSegment yields the proof-of-fetch marker for the URL shapes we post", () => {
  // The marker is what stops a 200 login wall from screening clean. Reddit
  // comment permalinks come in several shapes depending on who pasted them, so
  // all of them have to resolve to the comment id.
  assert.equal(
    lastSegment("https://old.reddit.com/r/x/comments/1vr76ea/-/p51vgpj"),
    "p51vgpj",
  );
  assert.equal(
    lastSegment("https://www.reddit.com/r/x/comments/1vr76ea/comment/p51vgpj/"),
    "p51vgpj",
  );
  assert.equal(
    lastSegment("https://old.reddit.com/r/x/comments/1vr76ea/-/p51vgpj.json"),
    "p51vgpj",
  );
  // A thread URL with no comment falls back to the slug, which is still a
  // string the real page contains and a wall does not.
  assert.equal(
    lastSegment("https://old.reddit.com/r/x/comments/1vr76ea/alternativa_para_transmissao/"),
    "alternativa_para_transmissao",
  );
  // Garbage in, empty marker out: the guard then does not fire, which is the
  // right failure direction (we lose the check, we do not invent a pass).
  assert.equal(lastSegment("not a url"), "");
});

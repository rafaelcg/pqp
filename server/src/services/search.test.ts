import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SEARCH_HIGHLIGHT_CLOSE, SEARCH_HIGHLIGHT_OPEN } from "@pqp/shared";

/**
 * Message search, in the language the audience actually writes.
 *
 * The index and the query are the same statement said twice — once in
 * schema.sql's generated column, once in whatever the service sends — and when
 * they disagree nothing raises: the GIN index is simply never satisfied and
 * search returns nothing for reasons no log records. So most of what is pinned
 * here is not "search works" but "these two still agree", plus the specific
 * Portuguese behaviours that motivated the configuration and the specific ones
 * it knowingly does not fix.
 */

// TEST_DATABASE_URL wins — see the note in api.test.ts. Set it to point the
// suite at a scratch database instead of the one `pnpm dev` is using.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer } = await import("./servers.js");
const { searchMessages } = await import("./search.js");

describeDb("message search in Portuguese", () => {
  let author: { id: string };
  let serverId: string;
  let channelId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    author = await upsertUser({
      clerkId: "clerk_ana",
      displayName: "Ana",
      avatarUrl: null,
    });
    const created = await createServer("Servidor", author.id);
    serverId = created.server.id;
    channelId = created.channels.find((c) => c.type === "text")!.id;
  });

  async function seed(...bodies: string[]): Promise<void> {
    await getPool().query(
      `INSERT INTO messages (channel_id, author_id, body)
       SELECT $1, $2, b FROM unnest($3::text[]) b`,
      [channelId, author.id, bodies],
    );
  }

  /** The bodies a query finds, so an expectation reads like the product does. */
  async function find(query: string): Promise<string[]> {
    const { results } = await searchMessages(serverId, author.id, query, 20);
    return results.map((r) =>
      r.snippet
        .split(SEARCH_HIGHLIGHT_OPEN)
        .join("")
        .split(SEARCH_HIGHLIGHT_CLOSE)
        .join(""),
    );
  }

  /**
   * Seeds two messages and asserts each one's word finds both. Both directions
   * every time: a rule applied to the query but not to the body passes half of
   * these, and half is the half a user does not hit first.
   */
  async function expectMutual(
    a: { word: string; body: string },
    b: { word: string; body: string },
  ): Promise<void> {
    await seed(a.body, b.body);
    expect(await find(a.word), `${a.word} -> ${b.body}`).toHaveLength(2);
    expect(await find(b.word), `${b.word} -> ${a.body}`).toHaveLength(2);
  }

  // ------------------------------------------------------------- stemming

  it("finds 'jogar' from 'jogando', and back", async () => {
    await expectMutual(
      { word: "jogar", body: "vamos jogar hoje" },
      { word: "jogando", body: "estou jogando agora" },
    );
  });

  it("folds the rest of the conjugation onto the same stem", async () => {
    await seed("quem quer jogar", "jogamos ontem", "jogando desde cedo");
    expect(await find("jogar")).toHaveLength(3);
    expect(await find("jogamos")).toHaveLength(3);
  });

  it("finds 'mensagem' from 'mensagens', and back", async () => {
    // Snowball's Portuguese stemmer leaves -ens plurals alone, so this is the
    // pqp_pt_plurals rewrite in schema.sql, not the stemmer.
    await expectMutual(
      { word: "mensagem", body: "apaguei a mensagem" },
      { word: "mensagens", body: "as mensagens sumiram" },
    );
  });

  it("folds the other -em/-ens nouns the same way", async () => {
    await seed("mandei uma imagem", "as imagens nao carregam");
    expect(await find("imagens")).toHaveLength(2);
    expect(await find("imagem")).toHaveLength(2);
  });

  it("folds -ção onto -ções, which the stemmer alone does not", async () => {
    await expectMutual(
      { word: "configuração", body: "mudei a configuração do servidor" },
      { word: "configurações", body: "as configurações sumiram" },
    );
  });

  // -------------------------------------------------------------- accents

  it("finds accented text from an unaccented query", async () => {
    await seed("não consegui entrar na reunião", "tudo certo por aqui");
    expect(await find("nao")).toHaveLength(1);
    expect(await find("reuniao")).toHaveLength(1);
  });

  it("finds unaccented text from an accented query", async () => {
    await seed("nao consegui entrar na reuniao", "tudo certo por aqui");
    expect(await find("não")).toHaveLength(1);
    expect(await find("reunião")).toHaveLength(1);
  });

  it("treats the two spellings of a word as one word", async () => {
    // The realistic corpus: the same room writes it both ways.
    await seed("você viu isso?", "voce viu isso?");
    expect(await find("você")).toHaveLength(2);
    expect(await find("voce")).toHaveLength(2);
  });

  it("still highlights the accented original in the snippet", async () => {
    await seed("a sessão de áudio ficou gravada");
    const { results } = await searchMessages(serverId, author.id, "sessao", 20);
    // The snippet is the message as written — folding happens in the index,
    // never in what is shown back.
    expect(results[0]!.snippet).toContain(`${SEARCH_HIGHLIGHT_OPEN}sessão`);
  });

  // ------------------------------------------------------------ stop words

  it("does not let Portuguese stop words empty a query", async () => {
    // 'de'/'para'/'com' are stop words to the Portuguese half and ordinary
    // words to the English one, so the ORed query still has something to match
    // — the two halves cover each other's stop word lists in both directions.
    await seed("o link para o canal de voz", "nada aqui");
    expect(await find("para o canal")).toHaveLength(1);
    expect(await find("canal de voz")).toHaveLength(1);
  });

  it("answers a query that is nothing but stop words without erroring", async () => {
    await seed("vamos com calma", "nada aqui");
    expect(await find("com")).toHaveLength(1);
    expect(await find("de")).toHaveLength(0);
  });

  // ------------------------------------------------------- English content

  it("still stems English, which is what most of this product is written in", async () => {
    await seed("we are deploying on friday", "nothing to see here");
    expect(await find("deploy")).toHaveLength(1);
    expect(await find("deployed")).toHaveLength(1);
  });

  it("keeps English verb forms together even in a Portuguese room", async () => {
    await seed("o build quebrou depois do merge", "running the tests again");
    expect(await find("run")).toHaveLength(1);
    expect(await find("merging")).toHaveLength(1);
  });

  it("highlights a hit that only the English half could find", async () => {
    // ts_headline parses under one configuration; Portuguese would render this
    // snippet with nothing marked, which is why pqp_search_headline falls back.
    await seed("we deployed the fix last night");
    const { results } = await searchMessages(serverId, author.id, "deploying", 20);
    expect(results[0]!.snippet).toContain(`${SEARCH_HIGHLIGHT_OPEN}deployed`);
  });

  it("keeps a phrase query a phrase", async () => {
    await seed("a nova mensagem chegou", "a mensagem nova chegou");
    expect(await find('"nova mensagem"')).toHaveLength(1);
  });

  it("keeps an excluded term excluded in both halves", async () => {
    await seed("o deploy quebrou tudo", "o deploy passou limpo");
    const hits = await find("deploy -quebrou");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("passou limpo");
  });

  // -------------------------------------------------------- known limits

  it("does NOT fold the -l/-is plural, which is a documented gap", async () => {
    // "canal"/"canais", "papel"/"papéis". Disambiguating these needs the accent
    // the unaccented spellings do not carry — see schema.sql. Pinned so that
    // making it work is a deliberate change and not a surprise.
    await seed("entra no canal", "os canais estao vazios");
    expect(await find("canais")).toHaveLength(1);
    expect(await find("canal")).toHaveLength(1);
  });

  // ------------------------------------------------- index/query agreement

  it("indexes every message with the same rules the query is built with", async () => {
    // The failure this guards is silent: a stored vector the query function can
    // never satisfy returns zero rows and logs nothing. Asking the database to
    // check every row against a query built from its own body is the cheapest
    // possible statement of "these two agree".
    await seed(
      "as configurações das mensagens não carregam",
      "deploying the new build tonight",
      "reunião às 18h com o time",
      "jogando valorant com os amigos",
    );
    const { rows } = await getPool().query<{ body: string }>(
      `SELECT body FROM messages
        WHERE NOT (search_tsv @@ pqp_search_query(body))`,
    );
    expect(rows.map((r) => r.body)).toEqual([]);
  });

  it("re-applies the schema without rewriting the messages table", async () => {
    // schema.sql runs on every boot and the search vector is a STORED generated
    // column, so an unguarded change of definition would rewrite the table and
    // rebuild its GIN index once per restart.
    await seed("uma mensagem qualquer");
    const physical = async () =>
      (
        await getPool().query<{ heap: string; idx: string; ctids: string }>(
          `SELECT pg_relation_filenode('messages')::text AS heap,
                  pg_relation_filenode('idx_messages_search')::text AS idx,
                  (SELECT string_agg(ctid::text, ',' ORDER BY id) FROM messages)
                    AS ctids`,
        )
      ).rows[0]!;

    const before = await physical();
    await initDb();
    await initDb();
    expect(await physical()).toEqual(before);
  });
});

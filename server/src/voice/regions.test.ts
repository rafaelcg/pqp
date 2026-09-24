import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countryFromHeaders,
  decideSfuRegion,
  defaultRegionId,
  homeRegionId,
  regionCountryMap,
  resetRoomRegions,
  resolveSfuRegion,
  sfuRegions,
  type SfuRegionPolicyInput,
} from "./regions.js";

const ENV = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LIVEKIT_REGIONS",
  "LIVEKIT_HOME_REGION",
  "LIVEKIT_REGION_COUNTRIES",
  "LIVEKIT_REGION_DEFAULT",
  "LIVEKIT_API_KEY_MIA",
  "LIVEKIT_API_SECRET_MIA",
];

describe("SFU region config", () => {
  beforeEach(() => {
    for (const name of ENV) {
      delete process.env[name];
    }
    process.env.LIVEKIT_URL = "wss://sfu.pqp.gg";
    process.env.LIVEKIT_API_KEY = "home-key";
    process.env.LIVEKIT_API_SECRET = "home-secret";
    resetRoomRegions();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const name of ENV) {
      delete process.env[name];
    }
    vi.restoreAllMocks();
  });

  it("is single-region (null) with LIVEKIT_REGIONS unset, which is today's behaviour", () => {
    expect(sfuRegions()).toBeNull();
    expect(resolveSfuRegion("mia")).toMatchObject({
      id: "sao",
      url: "wss://sfu.pqp.gg",
      apiKey: "home-key",
      home: true,
    });
    expect(regionCountryMap()).toEqual(new Map());
  });

  it("is single-region without LiveKit at all, even with the list set", () => {
    process.env.LIVEKIT_REGIONS = "mia:wss://sfu-mia.pqp.gg";
    delete process.env.LIVEKIT_URL;
    expect(sfuRegions()).toBeNull();
    expect(resolveSfuRegion(null)).toBeNull();
  });

  it("parses regions home first, with per-region keys falling back to the home pair", () => {
    process.env.LIVEKIT_REGIONS =
      "sao:wss://sfu.pqp.gg, mia:wss://sfu-mia.pqp.gg ,lon:wss://sfu-lon.pqp.gg";
    process.env.LIVEKIT_API_KEY_MIA = "mia-key";
    process.env.LIVEKIT_API_SECRET_MIA = "mia-secret";
    const regions = sfuRegions()!;
    expect(regions.map((region) => region.id)).toEqual(["sao", "mia", "lon"]);
    expect(regions[1]).toMatchObject({
      url: "wss://sfu-mia.pqp.gg",
      apiKey: "mia-key",
      apiSecret: "mia-secret",
      home: false,
    });
    expect(regions[2]).toMatchObject({ apiKey: "home-key", apiSecret: "home-secret" });
  });

  it("drops a malformed entry without dropping the good ones", () => {
    process.env.LIVEKIT_REGIONS = "Bad Id:wss://x,mia:https://sfu-mia.pqp.gg,lon:wss://sfu-lon.pqp.gg,lon:wss://dup";
    expect(sfuRegions()!.map((region) => `${region.id}=${region.url}`)).toEqual([
      "sao=wss://sfu.pqp.gg",
      "lon=wss://sfu-lon.pqp.gg",
    ]);
  });

  it("an entry naming the home id cannot move home off LIVEKIT_URL", () => {
    process.env.LIVEKIT_REGIONS = "sao:wss://elsewhere,mia:wss://sfu-mia.pqp.gg";
    expect(sfuRegions()![0]).toMatchObject({ id: "sao", url: "wss://sfu.pqp.gg" });
  });

  it("names home by LIVEKIT_HOME_REGION", () => {
    process.env.LIVEKIT_HOME_REGION = "GRU";
    process.env.LIVEKIT_REGIONS = "mia:wss://sfu-mia.pqp.gg";
    expect(homeRegionId()).toBe("gru");
    expect(sfuRegions()![0]!.id).toBe("gru");
  });

  it("resolves an unknown or removed region id to home", () => {
    process.env.LIVEKIT_REGIONS = "mia:wss://sfu-mia.pqp.gg";
    expect(resolveSfuRegion("mia")!.id).toBe("mia");
    expect(resolveSfuRegion("lon")!.id).toBe("sao");
    expect(resolveSfuRegion(null)!.id).toBe("sao");
  });

  it("maps countries only to configured regions, and defaults to home", () => {
    process.env.LIVEKIT_REGIONS = "mia:wss://sfu-mia.pqp.gg";
    process.env.LIVEKIT_REGION_COUNTRIES = "us:mia, CA:mia,GB:lon,XYZ:mia";
    expect(regionCountryMap()).toEqual(
      new Map([
        ["US", "mia"],
        ["CA", "mia"],
      ]),
    );
    expect(defaultRegionId()).toBe("sao");
    process.env.LIVEKIT_REGION_DEFAULT = "mia";
    expect(defaultRegionId()).toBe("mia");
    process.env.LIVEKIT_REGION_DEFAULT = "lon";
    expect(defaultRegionId()).toBe("sao");
  });
});

describe("CF-IPCountry", () => {
  it("normalises a country and refuses Cloudflare's non-answers", () => {
    expect(countryFromHeaders({ "cf-ipcountry": "us" })).toBe("US");
    expect(countryFromHeaders({ "cf-ipcountry": " BR " })).toBe("BR");
    expect(countryFromHeaders({ "cf-ipcountry": "XX" })).toBeNull();
    expect(countryFromHeaders({ "cf-ipcountry": "T1" })).toBeNull();
    expect(countryFromHeaders({ "cf-ipcountry": "USA" })).toBeNull();
    expect(countryFromHeaders({})).toBeNull();
  });
});

describe("decideSfuRegion", () => {
  const base: SfuRegionPolicyInput = {
    regionIds: ["sao", "mia", "lon"],
    defaultRegion: "sao",
    countryMap: new Map([
      ["US", "mia"],
      ["GB", "lon"],
    ]),
    channel: { kind: "server", type: "voice", sfuRegion: null },
    country: "US",
    clientDeclaresRegions: true,
  };

  it("single-region mode answers home and reads nothing else", () => {
    expect(decideSfuRegion({ ...base, regionIds: null })).toEqual({
      region: "sao",
      reason: "single",
    });
  });

  it("routes the first joiner's country", () => {
    expect(decideSfuRegion(base)).toEqual({ region: "mia", reason: "country" });
    expect(decideSfuRegion({ ...base, country: "GB" })).toEqual({
      region: "lon",
      reason: "country",
    });
  });

  it("sends an unmapped or missing country to the default", () => {
    expect(decideSfuRegion({ ...base, country: "BR" })).toEqual({
      region: "sao",
      reason: "default",
    });
    expect(decideSfuRegion({ ...base, country: null, defaultRegion: "mia" })).toEqual({
      region: "mia",
      reason: "default",
    });
  });

  it("keeps a room home for a first joiner that did not declare sfu-region", () => {
    expect(decideSfuRegion({ ...base, clientDeclaresRegions: false })).toEqual({
      region: "sao",
      reason: "old-client",
    });
  });

  it("the operator override beats the country", () => {
    expect(
      decideSfuRegion({
        ...base,
        channel: { ...base.channel, sfuRegion: "lon" },
      }),
    ).toEqual({ region: "lon", reason: "override" });
    // An override naming a region this deployment does not run is automatic.
    expect(
      decideSfuRegion({
        ...base,
        channel: { ...base.channel, sfuRegion: "fra" },
      }),
    ).toEqual({ region: "mia", reason: "country" });
  });

  it("a watch party channel stays home, ahead of the override and the country", () => {
    expect(
      decideSfuRegion({
        ...base,
        channel: { kind: "server", type: "watch_party", sfuRegion: "mia" },
      }),
    ).toEqual({ region: "sao", reason: "watch-party" });
  });

  it("a conversation stays home", () => {
    expect(
      decideSfuRegion({
        ...base,
        channel: { kind: "dm", type: "voice", sfuRegion: null },
      }),
    ).toEqual({ region: "sao", reason: "dm" });
  });
});

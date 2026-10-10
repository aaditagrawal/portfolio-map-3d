import { describe, expect, it } from "vitest";
import { planetEntryHref } from "./entry.ts";

describe("entering a planet", () => {
  it("opens the framework walk view beneath its published base path", () => {
    expect(planetEntryHref({ id: "example-collective", url: "https://wearenexus.xyz/example" }))
      .toBe("https://wearenexus.xyz/example/?from=nexus&view=walk");
  });
  it("opens the geographical walk page beneath the India project path", () => {
    expect(planetEntryHref({ id: "india-ecosystem-map", url: "https://fritzhand.github.io/startup-india-guide" }))
      .toBe("https://fritzhand.github.io/startup-india-guide/walkable-map.html?from=nexus");
    expect(planetEntryHref({ id: "florida-ecosystem-map", url: "https://map.embarccollective.com/" }))
      .toBe("https://map.embarccollective.com/walkable-map.html?from=nexus");
  });
  it("uses the same device hostname for local companion servers", () => {
    expect(planetEntryHref({ id: "example-collective", url: "https://wearenexus.xyz/example" }, "http://100.91.157.43:5173"))
      .toBe("http://100.91.157.43:5174/?from=nexus&view=walk");
    expect(planetEntryHref({ id: "india-ecosystem-map", url: "https://fritzhand.github.io/startup-india-guide" }, "http://2.3.4.1:5173"))
      .toBe("http://2.3.4.1:5175/walkable-map.html?from=nexus");
  });
  it("keeps other maps on their published server in development", () => {
    expect(planetEntryHref({ id: "embarc-collective", url: "https://community.embarccollective.com" }, "http://localhost:5173"))
      .toBe("https://community.embarccollective.com/?from=nexus&view=walk");
  });
});

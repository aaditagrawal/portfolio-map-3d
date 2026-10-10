import { instanceHref } from "../../../federation/protocol.ts";

/** Direct entry into a map's walk view, preserving the Nexus arrival marker. */
export function planetEntryHref(world: { id: string; url: string }, devOrigin?: string): string {
  const u = new URL(instanceHref(world.url));
  const geographic = world.id === "india-ecosystem-map" || world.id === "florida-ecosystem-map";
  if (geographic) u.pathname += "walkable-map.html";
  else u.searchParams.set("view", "walk");

  // These are the two companion servers available in this development workspace.
  if (devOrigin && (world.id === "example-collective" || world.id === "india-ecosystem-map")) {
    const local = new URL(devOrigin);
    u.protocol = local.protocol;
    u.hostname = local.hostname;
    u.port = world.id === "example-collective" ? "5174" : "5175";
    u.pathname = geographic ? "/walkable-map.html" : "/";
  }
  return u.toString();
}

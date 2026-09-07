import type { Junction, Lane, OpenDriveDocument, PlanGeometry, Polynomial, Road, RoadLink } from "./model.js";
import { child, children, numberAttribute, parseXml, requiredAttribute, requiredChild, type XmlElement } from "./xml.js";

function polynomial(element: XmlElement, sName: string): Polynomial {
  return { s: numberAttribute(element, sName), a: numberAttribute(element, "a"), b: numberAttribute(element, "b"), c: numberAttribute(element, "c"), d: numberAttribute(element, "d") };
}
function optionalInteger(element: XmlElement | undefined, name: string): number | undefined {
  if (!element) return undefined; const value = Number(requiredAttribute(element, name)); if (!Number.isInteger(value)) throw new Error(`INVALID_OPENDRIVE: ${element.name}/@${name} is not an integer`); return value;
}
function parseRoadLink(element: XmlElement | undefined): RoadLink | undefined {
  if (!element) return undefined; const elementType = requiredAttribute(element, "elementType");
  if (elementType !== "road" && elementType !== "junction") throw new Error(`INVALID_OPENDRIVE: unknown road link type ${elementType}`);
  const contact = element.attributes.contactPoint; if (contact !== undefined && contact !== "start" && contact !== "end") throw new Error(`INVALID_OPENDRIVE: bad contactPoint ${contact}`);
  return { elementType, elementId: requiredAttribute(element, "elementId"), ...(contact === undefined ? {} : { contactPoint: contact }) };
}
function parseLane(element: XmlElement): Lane {
  const id = Number(requiredAttribute(element, "id")); if (!Number.isInteger(id)) throw new Error("INVALID_OPENDRIVE: lane id is not an integer");
  const vectorLane = child(child(element, "userData") ?? { name: "", attributes: {}, children: [] }, "vectorLane");
  const direction = vectorLane?.attributes.travelDir ?? (id < 0 ? "forward" : id > 0 ? "backward" : "undirected");
  if (direction !== "forward" && direction !== "backward" && direction !== "undirected") throw new Error(`INVALID_OPENDRIVE: unsupported travelDir ${direction}`);
  const link = child(element, "link"); const predecessorId = optionalInteger(link && child(link, "predecessor"), "id"); const successorId = optionalInteger(link && child(link, "successor"), "id");
  return {
    id, type: requiredAttribute(element, "type"), ...(vectorLane?.attributes.laneId ? { sourceGuid: vectorLane.attributes.laneId } : {}), travelDirection: direction,
    widths: children(element, "width").map((entry) => polynomial(entry, "sOffset")).sort((a, b) => a.s - b.s),
    ...(predecessorId === undefined ? {} : { predecessorId }), ...(successorId === undefined ? {} : { successorId })
  };
}
function parseGeometry(element: XmlElement): PlanGeometry {
  const primitiveElements = element.children.filter((entry) => entry.name === "line" || entry.name === "arc" || entry.name === "spiral" || entry.name === "poly3" || entry.name === "paramPoly3");
  if (primitiveElements.length !== 1) throw new Error("INVALID_OPENDRIVE: geometry must contain exactly one primitive");
  const primitive = primitiveElements[0]!;
  if (primitive.name === "poly3" || primitive.name === "paramPoly3") throw new Error(`UNSUPPORTED_PLANVIEW_GEOMETRY: ${primitive.name}`);
  return {
    s: numberAttribute(element, "s"), x: numberAttribute(element, "x"), y: numberAttribute(element, "y"), heading: numberAttribute(element, "hdg"), length: numberAttribute(element, "length"),
    primitive: primitive.name === "line" ? { kind: "line" } : primitive.name === "arc" ? { kind: "arc", curvature: numberAttribute(primitive, "curvature") } : { kind: "spiral", curvatureStart: numberAttribute(primitive, "curvStart"), curvatureEnd: numberAttribute(primitive, "curvEnd") }
  };
}
function mphToMps(value: number): number { return value * 0.44704; }
function parseRoad(element: XmlElement): Road {
  const link = child(element, "link"); const type = children(element, "type").sort((a, b) => numberAttribute(a, "s") - numberAttribute(b, "s"))[0]; const speed = type && child(type, "speed");
  const speedMps = speed ? (requiredAttribute(speed, "unit") === "mph" ? mphToMps(numberAttribute(speed, "max")) : numberAttribute(speed, "max")) : undefined;
  const lanes = requiredChild(element, "lanes");
  return {
    id: requiredAttribute(element, "id"), name: element.attributes.name ?? "", length: numberAttribute(element, "length"), junctionId: requiredAttribute(element, "junction"),
    ...(type?.attributes.type ? { roadType: type.attributes.type } : {}), ...(speedMps === undefined ? {} : { speedMps }),
    ...(link && child(link, "predecessor") ? { predecessor: parseRoadLink(child(link, "predecessor"))! } : {}),
    ...(link && child(link, "successor") ? { successor: parseRoadLink(child(link, "successor"))! } : {}),
    geometries: children(requiredChild(element, "planView"), "geometry").map(parseGeometry).sort((a, b) => a.s - b.s),
    elevations: children(child(element, "elevationProfile") ?? { name: "", attributes: {}, children: [] }, "elevation").map((entry) => polynomial(entry, "s")).sort((a, b) => a.s - b.s),
    laneOffsets: children(lanes, "laneOffset").map((entry) => polynomial(entry, "s")).sort((a, b) => a.s - b.s),
    laneSections: children(lanes, "laneSection").map((section) => ({
      s: numberAttribute(section, "s"),
      lanes: ["left", "center", "right"].flatMap((side) => children(child(section, side) ?? { name: "", attributes: {}, children: [] }, "lane").map(parseLane)).sort((a, b) => a.id - b.id)
    })).sort((a, b) => a.s - b.s),
    hasLateralProfile: child(element, "lateralProfile") !== undefined,
    objectCount: children(child(element, "objects") ?? { name: "", attributes: {}, children: [] }, "object").length,
    signalCount: children(child(element, "signals") ?? { name: "", attributes: {}, children: [] }, "signal").length
  };
}

export function parseOpenDrive(xml: string): OpenDriveDocument {
  const root = parseXml(xml); if (root.name !== "OpenDRIVE") throw new Error("INVALID_OPENDRIVE: root must be OpenDRIVE");
  const header = requiredChild(root, "header"); const version = `${requiredAttribute(header, "revMajor")}.${requiredAttribute(header, "revMinor")}`;
  if (version !== "1.5") throw new Error(`UNSUPPORTED_OPENDRIVE_VERSION: ${version}`);
  const junctions: Junction[] = children(root, "junction").map((junction) => ({
    id: requiredAttribute(junction, "id"), connections: children(junction, "connection").map((connection) => {
      const contactPoint = requiredAttribute(connection, "contactPoint"); if (contactPoint !== "start" && contactPoint !== "end") throw new Error(`INVALID_OPENDRIVE: bad contactPoint ${contactPoint}`);
      return { id: requiredAttribute(connection, "id"), incomingRoadId: requiredAttribute(connection, "incomingRoad"), connectingRoadId: requiredAttribute(connection, "connectingRoad"), contactPoint, laneLinks: children(connection, "laneLink").map((link) => ({ fromLaneId: numberAttribute(link, "from"), toLaneId: numberAttribute(link, "to") })) };
    })
  }));
  return { version, hasEmbeddedGeoreference: child(header, "geoReference") !== undefined, roads: children(root, "road").map(parseRoad), junctions };
}

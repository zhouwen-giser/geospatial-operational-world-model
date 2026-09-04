import { localToGeographic, type GeoreferenceConfig } from "./georeference.js";
import type { ChannelGeometry, Lane, LaneSection, LocalPoint, PlanGeometry, Polynomial, Road } from "./model.js";

function evalPolynomial(records: Polynomial[], s: number): number {
  let record: Polynomial | undefined;
  for (const candidate of records) { if (candidate.s <= s + 1e-10) record = candidate; else break; }
  if (!record) return 0; const ds = s - record.s;
  return record.a + record.b * ds + record.c * ds * ds + record.d * ds * ds * ds;
}

function integrateSpiral(geometry: PlanGeometry & { primitive: { kind: "spiral"; curvatureStart: number; curvatureEnd: number } }, ds: number): [number, number] {
  if (ds === 0) return [0, 0];
  let steps = Math.max(16, Math.ceil(ds / 0.125)); if (steps % 2) steps += 1;
  const h = ds / steps; const rate = (geometry.primitive.curvatureEnd - geometry.primitive.curvatureStart) / geometry.length;
  const heading = (u: number) => geometry.heading + geometry.primitive.curvatureStart * u + 0.5 * rate * u * u;
  let x = Math.cos(heading(0)) + Math.cos(heading(ds)); let y = Math.sin(heading(0)) + Math.sin(heading(ds));
  for (let i = 1; i < steps; i += 1) { const weight = i % 2 ? 4 : 2; x += weight * Math.cos(heading(i * h)); y += weight * Math.sin(heading(i * h)); }
  return [x * h / 3, y * h / 3];
}

export function evaluateReference(road: Road, s: number): LocalPoint {
  if (s < -1e-8 || s > road.length + 1e-8) throw new Error(`INVALID_ROAD_STATION: ${road.id}@${s}`);
  const station = Math.min(road.length, Math.max(0, s)); let geometry = road.geometries[0];
  for (const candidate of road.geometries) { if (candidate.s <= station + 1e-9) geometry = candidate; else break; }
  if (!geometry) throw new Error(`INVALID_OPENDRIVE: road ${road.id} has no planView geometry`);
  const ds = Math.min(geometry.length, Math.max(0, station - geometry.s)); let x: number; let y: number; let heading: number;
  if (geometry.primitive.kind === "line") { x = geometry.x + ds * Math.cos(geometry.heading); y = geometry.y + ds * Math.sin(geometry.heading); heading = geometry.heading; }
  else if (geometry.primitive.kind === "arc") {
    const curvature = geometry.primitive.curvature;
    if (Math.abs(curvature) < 1e-15) { x = geometry.x + ds * Math.cos(geometry.heading); y = geometry.y + ds * Math.sin(geometry.heading); heading = geometry.heading; }
    else { heading = geometry.heading + curvature * ds; x = geometry.x + (Math.sin(heading) - Math.sin(geometry.heading)) / curvature; y = geometry.y - (Math.cos(heading) - Math.cos(geometry.heading)) / curvature; }
  } else {
    const [dx, dy] = integrateSpiral(geometry as PlanGeometry & { primitive: { kind: "spiral"; curvatureStart: number; curvatureEnd: number } }, ds);
    const rate = (geometry.primitive.curvatureEnd - geometry.primitive.curvatureStart) / geometry.length;
    x = geometry.x + dx; y = geometry.y + dy; heading = geometry.heading + geometry.primitive.curvatureStart * ds + 0.5 * rate * ds * ds;
  }
  return { x, y, z: evalPolynomial(road.elevations, station), heading };
}

function evaluateLaneWidth(lane: Lane, localS: number): number {
  const width = evalPolynomial(lane.widths, localS);
  if (!Number.isFinite(width) || width < -1e-8) throw new Error(`INVALID_LANE_WIDTH: lane ${lane.id}@${localS}`);
  return Math.max(0, width);
}

function derivativeRoots(record: Polynomial): number[] {
  const linear = 2 * record.c; const quadratic = 3 * record.d;
  if (Math.abs(quadratic) < 1e-15) return Math.abs(linear) < 1e-15 ? [] : [-record.b / linear];
  const discriminant = linear * linear - 4 * quadratic * record.b; if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant); return [(-linear - root) / (2 * quadratic), (-linear + root) / (2 * quadratic)];
}

function exactWidthStatistics(road: Road, lane: Lane): { minM: number; maxM: number; meanM: number } {
  const sectionIndex = road.laneSections.findIndex((section) => section.lanes.includes(lane)); if (sectionIndex < 0) throw new Error(`INVALID_OPENDRIVE: lane ${lane.id} is not attached to road ${road.id}`);
  const section = road.laneSections[sectionIndex]!; const sectionLength = (road.laneSections[sectionIndex + 1]?.s ?? road.length) - section.s;
  let integral = 0; const candidates: number[] = [];
  for (let index = 0; index < lane.widths.length; index += 1) {
    const record = lane.widths[index]!; const end = Math.min(sectionLength, lane.widths[index + 1]?.s ?? sectionLength); const length = end - record.s; if (length < 0) throw new Error("INVALID_LANE_WIDTH: overlapping width records");
    const offsets = [0, length, ...derivativeRoots(record).filter((offset) => offset > 0 && offset < length)];
    candidates.push(...offsets.map((offset) => record.a + record.b * offset + record.c * offset ** 2 + record.d * offset ** 3));
    integral += record.a * length + record.b * length ** 2 / 2 + record.c * length ** 3 / 3 + record.d * length ** 4 / 4;
  }
  if (sectionLength <= 0 || candidates.length === 0 || candidates.some((value) => !Number.isFinite(value) || value < -1e-8)) throw new Error(`INVALID_LANE_WIDTH: lane ${lane.id} has no valid positive interval`);
  const minM = Math.max(0, Math.min(...candidates)); const maxM = Math.max(...candidates); const rawMean = integral / sectionLength;
  return { minM, maxM, meanM: Math.min(maxM, Math.max(minM, rawMean)) };
}

function sectionAt(road: Road, s: number): LaneSection {
  let result = road.laneSections[0]; for (const candidate of road.laneSections) { if (candidate.s <= s + 1e-9) result = candidate; else break; }
  if (!result) throw new Error(`INVALID_OPENDRIVE: road ${road.id} has no laneSection`); return result;
}

function centerOffset(road: Road, lane: Lane, s: number): { offset: number; width: number } {
  const section = sectionAt(road, s); const localS = s - section.s; const sign = lane.id > 0 ? 1 : -1;
  const innerWidth = section.lanes.filter((candidate) => Math.sign(candidate.id) === sign && Math.abs(candidate.id) < Math.abs(lane.id)).reduce((sum, candidate) => sum + evaluateLaneWidth(candidate, localS), 0);
  const width = evaluateLaneWidth(lane, localS);
  return { offset: evalPolynomial(road.laneOffsets, s) + sign * (innerWidth + width / 2), width };
}

function maximumStepForGeometry(geometry: PlanGeometry, maximumSegmentLengthM: number, maximumChordErrorM: number): number {
  const curvature = geometry.primitive.kind === "line" ? 0 : geometry.primitive.kind === "arc" ? Math.abs(geometry.primitive.curvature) : Math.max(Math.abs(geometry.primitive.curvatureStart), Math.abs(geometry.primitive.curvatureEnd));
  if (curvature < 1e-12) return maximumSegmentLengthM;
  const radius = 1 / curvature; const ratio = Math.max(-1, Math.min(1, 1 - maximumChordErrorM / radius));
  return Math.min(maximumSegmentLengthM, 2 * Math.acos(ratio) * radius);
}

export function samplingStations(road: Road, maximumSegmentLengthM = 1, maximumChordErrorM = 0.05): number[] {
  const stations = new Set<number>([0, road.length]);
  for (const geometry of road.geometries) {
    const segments = Math.max(1, Math.ceil(geometry.length / maximumStepForGeometry(geometry, maximumSegmentLengthM, maximumChordErrorM)));
    for (let i = 0; i <= segments; i += 1) stations.add(Math.min(road.length, geometry.s + geometry.length * i / segments));
  }
  for (const item of [...road.laneOffsets, ...road.elevations]) stations.add(item.s);
  for (let sectionIndex = 0; sectionIndex < road.laneSections.length; sectionIndex += 1) {
    const section = road.laneSections[sectionIndex]!; const sectionEnd = road.laneSections[sectionIndex + 1]?.s ?? road.length; stations.add(section.s);
    for (const lane of section.lanes) for (let widthIndex = 0; widthIndex < lane.widths.length; widthIndex += 1) {
      const width = lane.widths[widthIndex]!; const recordStart = section.s + width.s; const recordEnd = Math.min(sectionEnd, section.s + (lane.widths[widthIndex + 1]?.s ?? sectionEnd - section.s)); stations.add(recordStart);
      for (const root of derivativeRoots(width)) if (root > 0 && recordStart + root < recordEnd) stations.add(recordStart + root);
    }
  }
  const sorted = [...stations].filter((station) => station >= 0 && station <= road.length).sort((a, b) => a - b);
  return sorted.filter((station, index) => index === 0 || Math.abs(station - sorted[index - 1]!) > 1e-9);
}

export function compileLaneGeometry(road: Road, lane: Lane, config: GeoreferenceConfig): ChannelGeometry {
  const sectionIndex = road.laneSections.findIndex((section) => section.lanes.includes(lane)); if (sectionIndex < 0) throw new Error(`INVALID_OPENDRIVE: lane ${lane.id} is not attached to road ${road.id}`);
  const start = road.laneSections[sectionIndex]!.s; const end = road.laneSections[sectionIndex + 1]?.s ?? road.length;
  const samples = samplingStations(road).filter((station) => station >= start && station <= end).map((s) => { const reference = evaluateReference(road, s); const profile = centerOffset(road, lane, s); return { local: [reference.x - Math.sin(reference.heading) * profile.offset, reference.y + Math.cos(reference.heading) * profile.offset, reference.z] as [number, number, number], width: profile.width }; });
  if (lane.travelDirection === "backward") samples.reverse();
  return { localCoordinates: samples.map((sample) => sample.local), coordinates: samples.map((sample) => [...localToGeographic(sample.local, config)]), width: exactWidthStatistics(road, lane) };
}

export function compileReferenceGeometry(road: Road, config: GeoreferenceConfig): Array<[number, number, number]> {
  return samplingStations(road).map((station) => { const point = evaluateReference(road, station); return [...localToGeographic([point.x, point.y, point.z], config)]; });
}

export function minimumDrivingRoadWidth(road: Road): number {
  return Math.min(...samplingStations(road).map((s) => { const section = sectionAt(road, s); return section.lanes.filter((lane) => lane.type === "driving").reduce((sum, lane) => sum + evaluateLaneWidth(lane, s - section.s), 0); }));
}

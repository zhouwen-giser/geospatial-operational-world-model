# OpenDRIVE task-network compilation and authority boundary

## Scope

The OpenDRIVE management-plane compiler converts the locked RoadRunner `airport2.xodr` source into a deterministic task-level directed network. It is not a public Provider operation and it does not accept arbitrary paths through Gateway or Provider input. The compiler output is admitted through the Catalog first and is then bound to an immutable Network Foundation GraphVersion.

The active network contains only `driving` lane segments in the principal weak component. Every active directed channel becomes one `network_edge`, one forward `network_arc`, and one binding to its `routing_channels` Catalog Feature. Connections come only from explicit OpenDRIVE road/lane/junction links; geometric crossings do not create connectivity.

The locked acceptance cardinalities are:

| Item | Count |
|---|---:|
| Physical regular roads after Road 6 quarantine | 40 |
| Active directed routing channels | 244 |
| Regular-road directed channels | 80 |
| Drivable junction connectors | 164 |
| Explicit `ALLOWED_ONLY` transitions | 336 |
| Excluded non-driving connector roads | 60 |
| Quarantined Road 6 driving channels | 2 |

Any source-lock or cardinality difference fails closed. In particular, the compiler must not manufacture a successful 244-channel artifact when the source differs.

## Georeference authority

The only authorized transform for this version is `airport-roadrunner-linear-compat-v1`, method `LOCAL_LINEAR_DEGREES_COMPAT_V1`. It preserves compatibility with the supplied Python oracle:

```text
latitude  = 29.71950 + y / 110540.0
longitude = 106.81485 + x / 111320.0
altitude  = 500.0 + z
```

This is an `UNVERIFIED_COMPATIBILITY_TRANSFORM`. It is not surveying-certified, RTK-grade, or a production navigation accuracy claim. If a future XODR embeds `<geoReference>`, the compiler must require an explicit comparison or selection policy and must not silently replace this external transform.

## Data semantics

- `road_class` is `XODR_TOWN`; original source classifications remain in properties.
- `surface` is SQL `NULL`; `surfaceKnowledge=MISSING_IN_SOURCE` records the absence.
- Bridge and tunnel columns use database-required false defaults, while attributes record `structureSemantics=MISSING_IN_SOURCE`; false is not field confirmation.
- Width is the minimum lane width over the channel interval in `width_mm`; min/max/mean and source are retained in `profile_constraints`.
- Source speed is the uniform 40 mph fixed-point conversion and is marked low-confidence/unverified. A TravelProfile maximum speed caps traversal speed; it does not remove an otherwise eligible Arc.
- Unknown risk and energy dimensions have zero weights in the supplied distance/time CostProfiles and are described as unknown, not measured zero.
- The one XODR Object (`DashedCrosswalk`) is reported as not adopted. No complete environment-product semantics are inferred from it.

## Deterministic artifacts and traceability

The default output root is `artifacts/opendrive-task-network-v0.1/artifacts` and directly contains the compile manifest, physical roads, routing channels, allowed transitions, identity map, quarantine evidence, compile report, deterministic admission plan, and checksums. Its parent contains the versioned source lock and receives runtime acceptance reports. Deployment archives exclude every `reports/` directory and carry only this explicit runtime handoff. `admission-plan.json` is the management-plane-only materialization interface; it is not a public Provider capability. Hash-critical documents exclude absolute paths, wall-clock timestamps, random UUIDs, and database sequence values.

An active Arc is traced as follows:

```text
network_arc
  -> network_edge
  -> network_feature_binding
  -> Catalog routing_channels FeatureVersion
  -> identity-map source road/lane/lane-section/GUID
  -> physicalRoadGroupKey
  -> GDPS ROAD_SOURCE physical-road Feature
  -> locked XODR source hash + transform content hash
```

The raw XODR is a GDPS auxiliary source asset, never a GOWM public Provider file-path capability.

The development deployment archive therefore carries only the reviewed deterministic artifacts, their source locks, and the compiler/admission runtime context. It excludes ordinary fixtures, examples, and test-data trees. At compile time the raw XODR and Python georeference oracle are supplied as explicit absolute paths and mounted read-only by `scripts/opendrive-task-network.sh`; no workstation path is embedded in a hash-critical artifact.

## Authority and non-goals

GDPS owns the current `ROAD_SOURCE` product, auxiliary source assets, product quality, and general spatial queries. GOWM+ owns DatasetVersion, GraphVersion, topology, transition rules, profiles, costs, conditions, validation, and activation history. There are no cross-database foreign keys or Provider-to-Provider calls.

This task does not implement lane changing, signals, vehicle dynamics, lateral control, OSM import, trajectory HMM, route environment corridors, or autonomous-driving release acceptance.

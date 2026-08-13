# Demo seed

Run `npm run db:seed` after migrations. The TypeScript seed is idempotent and
creates AOI-1, AOI-7, cameras, incidents, available UGVs, vehicles, and sensors
around central Beijing. The runtime asks h3-pg to compute and store native H3
R7-R10 indexes during object/observation projection.

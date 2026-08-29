import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import pg from "pg";
import { migrate } from "./migrate.js";
import { persistControlledRegistry } from "./provision-world-platform-registry.js";
import { loadControlledProviderDeployments } from "../services/gateway/world-capability-gateway/src/config.js";

const { Pool } = pg;

export async function bootstrapWsgsSample(): Promise<void> {
  assertSampleDatabase(process.env.DATABASE_URL);
  await migrate();
  const registryConnection = required("GATEWAY_REGISTRY_DATABASE_URL");
  const admin = new Pool({ connectionString: required("DATABASE_URL"), max: 1 });
  const registry = new Pool({ connectionString: registryConnection, max: 1 });
  try {
    await installInstanceMarker(admin);
    await provisionLoader(admin);
    await installResetFunction(admin);
    await persistControlledRegistry(
      registry,
      await loadControlledProviderDeployments("config/world-platform-gateway-registry.json")
    );
  } finally {
    await Promise.all([admin.end(), registry.end()]);
  }
}

async function installResetFunction(pool: pg.Pool): Promise<void> {
  await pool.query(SAMPLE_RESET_FUNCTION_SQL);
}

export const SAMPLE_RESET_FUNCTION_SQL = String.raw`
    CREATE OR REPLACE FUNCTION gowm_sample_fixture.reset_sample_world(p_dry_run boolean DEFAULT false)
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, gowm_sample_fixture
    AS $function$
    DECLARE
      affected_table record;
      dependency_edge record;
      direct_targets text;
      join_predicate text;
      row_count_value bigint;
      unproven_count bigint;
      best_unproven_count bigint;
      affected_rows_before bigint := 0;
      affected_rows_after bigint := 0;
      non_fixture_rows_before bigint := 0;
      non_fixture_rows_after bigint := 0;
      protected_rows_before bigint := 0;
      protected_rows_after bigint := 0;
      migration_rows_before bigint := 0;
      migration_rows_after bigint := 0;
      marker_rows_before bigint := 0;
      marker_rows_after bigint := 0;
      sample_reference_rows_before bigint := 0;
      sample_reference_rows_after bigint := 0;
      sample_reference_catalog_rows_before bigint := 0;
      sample_reference_catalog_rows_after bigint := 0;
      sample_scope_rows_before bigint := 0;
      sample_scope_rows_after bigint := 0;
      sample_processing_runs_before bigint := 0;
      sample_processing_runs_after bigint := 0;
      relation_proven boolean;
      fixture_counts jsonb;
    BEGIN
      IF current_database() <> 'gowm_wsgs_sample' OR NOT EXISTS (
        SELECT 1 FROM gowm_sample_fixture.instance_marker
        WHERE fixture_id='gowm-wsgs-sample-world'
          AND schema_version='gowm-wsgs-sample-world/1.0'
          AND allowed_data_scopes=ARRAY['wsgs-demo','wsgs-hidden']::text[]
      ) THEN
        RAISE EXCEPTION 'sample reset database marker mismatch';
      END IF;

      CREATE TEMP TABLE sample_reset_affected (
        relation_oid oid PRIMARY KEY,
        schema_name text NOT NULL,
        table_name text NOT NULL,
        depth integer NOT NULL,
        guard_kind text,
        direct_target boolean NOT NULL,
        proven_safe boolean NOT NULL DEFAULT false,
        rows_before bigint NOT NULL DEFAULT 0,
        rows_after bigint NOT NULL DEFAULT 0
      ) ON COMMIT DROP;

      INSERT INTO pg_temp.sample_reset_affected(
        relation_oid,schema_name,table_name,depth,guard_kind,direct_target
      )
        SELECT relation.oid,namespace.nspname,relation.relname,0,'DATA_SCOPE',true
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
        WHERE namespace.nspname NOT IN ('pg_catalog','information_schema','gowm_sample_fixture')
          AND namespace.nspname NOT LIKE 'pg_%'
          AND relation.relkind IN ('r','p')
          AND NOT relation.relispartition
          AND attribute.attname='data_scope_key'
          AND NOT attribute.attisdropped
          AND NOT (
            namespace.nspname='public' AND relation.relname IN (
              'world_reference_identity','world_reference_descriptor_version','world_reference_name',
              'world_reference_external_identifier','reference_search_projection'
            )
          )
        ON CONFLICT (relation_oid) DO NOTHING;

      INSERT INTO pg_temp.sample_reset_affected(
        relation_oid,schema_name,table_name,depth,guard_kind,direct_target
      )
        SELECT relation.oid,namespace.nspname,relation.relname,0,'DATA_SCOPE_CLAIM',true
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
        WHERE namespace.nspname NOT IN ('pg_catalog','information_schema','gowm_sample_fixture')
          AND namespace.nspname NOT LIKE 'pg_%'
          AND relation.relkind IN ('r','p')
          AND NOT relation.relispartition
          AND attribute.attname='data_scope_claim'
          AND NOT attribute.attisdropped
        ON CONFLICT (relation_oid) DO NOTHING;

      INSERT INTO pg_temp.sample_reset_affected(
        relation_oid,schema_name,table_name,depth,guard_kind,direct_target
      )
      SELECT relation.oid,namespace.nspname,relation.relname,0,'SITUATION_CELL',true
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public' AND relation.relname='situation_cell'
        AND relation.relkind IN ('r','p') AND NOT relation.relispartition
      ON CONFLICT (relation_oid) DO NOTHING;

      FOR affected_table IN
        SELECT * FROM pg_temp.sample_reset_affected WHERE direct_target
        ORDER BY schema_name,table_name
      LOOP
        IF affected_table.guard_kind='DATA_SCOPE' THEN
          EXECUTE format(
            'SELECT count(*) FILTER (WHERE data_scope_key IN ($1,$2))::bigint,count(*) FILTER (WHERE data_scope_key IS NULL OR data_scope_key NOT IN ($1,$2))::bigint FROM %I.%I',
            affected_table.schema_name,affected_table.table_name
          ) INTO row_count_value,unproven_count USING 'wsgs-demo','wsgs-hidden';
        ELSIF affected_table.guard_kind='DATA_SCOPE_CLAIM' THEN
          EXECUTE format(
            'SELECT count(*) FILTER (WHERE data_scope_claim IN ($1,$2))::bigint,count(*) FILTER (WHERE data_scope_claim IS NULL OR data_scope_claim NOT IN ($1,$2))::bigint FROM %I.%I',
            affected_table.schema_name,affected_table.table_name
          ) INTO row_count_value,unproven_count USING 'wsgs-demo','wsgs-hidden';
        ELSIF affected_table.guard_kind='SITUATION_CELL' THEN
          SELECT count(*)::bigint INTO row_count_value FROM public.situation_cell;
          SELECT count(*)::bigint INTO unproven_count
          FROM public.situation_cell cell
          WHERE NOT EXISTS (
            SELECT 1
            FROM (
              SELECT geometry.h3_r7::text AS h3_index,7::smallint AS resolution
              FROM public.world_object_geometry geometry
              JOIN public.world_object object_record ON object_record.id=geometry.object_id
              WHERE object_record.data_scope_key IN ('wsgs-demo','wsgs-hidden')
              UNION ALL SELECT geometry.h3_r8::text,8::smallint
              FROM public.world_object_geometry geometry
              JOIN public.world_object object_record ON object_record.id=geometry.object_id
              WHERE object_record.data_scope_key IN ('wsgs-demo','wsgs-hidden')
              UNION ALL SELECT geometry.h3_r9::text,9::smallint
              FROM public.world_object_geometry geometry
              JOIN public.world_object object_record ON object_record.id=geometry.object_id
              WHERE object_record.data_scope_key IN ('wsgs-demo','wsgs-hidden')
              UNION ALL SELECT geometry.h3_r10::text,10::smallint
              FROM public.world_object_geometry geometry
              JOIN public.world_object object_record ON object_record.id=geometry.object_id
              WHERE object_record.data_scope_key IN ('wsgs-demo','wsgs-hidden')
              UNION ALL SELECT position.h3_r7::text,7::smallint
              FROM public.position_measurement position
              JOIN public.measurement measurement_record ON measurement_record.measurement_id=position.measurement_id
              JOIN public.world_observation observation_record ON observation_record.observation_id=measurement_record.observation_id
              WHERE observation_record.data_scope_key IN ('wsgs-demo','wsgs-hidden')
              UNION ALL SELECT position.h3_r8::text,8::smallint
              FROM public.position_measurement position
              JOIN public.measurement measurement_record ON measurement_record.measurement_id=position.measurement_id
              JOIN public.world_observation observation_record ON observation_record.observation_id=measurement_record.observation_id
              WHERE observation_record.data_scope_key IN ('wsgs-demo','wsgs-hidden')
              UNION ALL SELECT position.h3_r9::text,9::smallint
              FROM public.position_measurement position
              JOIN public.measurement measurement_record ON measurement_record.measurement_id=position.measurement_id
              JOIN public.world_observation observation_record ON observation_record.observation_id=measurement_record.observation_id
              WHERE observation_record.data_scope_key IN ('wsgs-demo','wsgs-hidden')
              UNION ALL SELECT position.h3_r10::text,10::smallint
              FROM public.position_measurement position
              JOIN public.measurement measurement_record ON measurement_record.measurement_id=position.measurement_id
              JOIN public.world_observation observation_record ON observation_record.observation_id=measurement_record.observation_id
              WHERE observation_record.data_scope_key IN ('wsgs-demo','wsgs-hidden')
            ) fixture_cell
            WHERE fixture_cell.h3_index=cell.h3_index::text AND fixture_cell.resolution=cell.resolution
          );
          row_count_value := row_count_value-unproven_count;
        ELSE
          RAISE EXCEPTION 'sample reset has no direct ownership guard for %.%',
            affected_table.schema_name,affected_table.table_name;
        END IF;

        UPDATE pg_temp.sample_reset_affected
        SET rows_before=row_count_value,proven_safe=(unproven_count=0)
        WHERE relation_oid=affected_table.relation_oid;
        affected_rows_before := affected_rows_before+row_count_value;
        non_fixture_rows_before := non_fixture_rows_before+unproven_count;
        IF row_count_value<>0 AND unproven_count<>0 THEN
          RAISE EXCEPTION 'sample reset refuses % unowned rows in %.%',
            unproven_count,affected_table.schema_name,affected_table.table_name;
        END IF;
      END LOOP;

      DELETE FROM pg_temp.sample_reset_affected
      WHERE direct_target AND rows_before=0
        AND NOT (
          schema_name='gowm_capability'
          AND table_name='gateway_job'
          AND proven_safe
        );

      WITH RECURSIVE dependency_closure(relation_oid,depth,path) AS (
        SELECT relation_oid,0,ARRAY[relation_oid]::oid[]
        FROM pg_temp.sample_reset_affected WHERE direct_target
        UNION ALL
        SELECT constraint_record.conrelid,dependency_closure.depth+1,
               dependency_closure.path||constraint_record.conrelid
        FROM dependency_closure
        JOIN pg_constraint constraint_record
          ON constraint_record.contype='f'
         AND constraint_record.confrelid=dependency_closure.relation_oid
        WHERE NOT constraint_record.conrelid=ANY(dependency_closure.path)
      ), minimum_depth AS (
        SELECT relation_oid,min(depth) AS depth FROM dependency_closure GROUP BY relation_oid
      )
      INSERT INTO pg_temp.sample_reset_affected(
        relation_oid,schema_name,table_name,depth,guard_kind,direct_target
      )
      SELECT relation.oid,namespace.nspname,relation.relname,minimum_depth.depth,NULL,false
      FROM minimum_depth
      JOIN pg_class relation ON relation.oid=minimum_depth.relation_oid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE relation.relkind IN ('r','p') AND NOT relation.relispartition
      ON CONFLICT (relation_oid) DO UPDATE
        SET depth=LEAST(pg_temp.sample_reset_affected.depth,EXCLUDED.depth);

      UPDATE pg_temp.sample_reset_affected
      SET guard_kind='SAMPLE_IDEMPOTENCY'
      WHERE schema_name='gowm_capability' AND table_name='idempotency_record';
      UPDATE pg_temp.sample_reset_affected
      SET guard_kind='SAMPLE_EXECUTION_RECEIPT'
      WHERE schema_name='gowm_capability' AND table_name='execution_receipt';
      UPDATE pg_temp.sample_reset_affected
      SET guard_kind='SAMPLE_GATEWAY_AUDIT'
      WHERE schema_name='gowm_capability' AND table_name='gateway_audit_event';

      CREATE TEMP TABLE sample_reset_owned_idempotency ON COMMIT DROP AS
      SELECT idempotency.idempotency_record_id,idempotency.receipt_id
      FROM gowm_capability.idempotency_record idempotency
      WHERE idempotency.idempotency_key LIKE 'sample-%'
         OR EXISTS (
           SELECT 1
           FROM gowm_capability.gateway_audit_event audit_event
           JOIN gowm_sample_fixture.instance_marker marker
             ON marker.fixture_id='gowm-wsgs-sample-world'
            AND marker.schema_version='gowm-wsgs-sample-world/1.0'
           CROSS JOIN LATERAL unnest(marker.allowed_data_scopes) AS allowed_scope(scope_key)
           WHERE audit_event.operation_id=idempotency.operation_id
             AND audit_event.operation_version=idempotency.operation_version
             AND audit_event.request_hash=idempotency.request_hash
             AND audit_event.data_scope_hash=
               'sha256:'||encode(
                 public.digest(convert_to(to_jsonb(allowed_scope.scope_key)::text,'UTF8'),'sha256'),
                 'hex'
               )
         );

      FOR affected_table IN
        SELECT * FROM pg_temp.sample_reset_affected WHERE NOT direct_target
        ORDER BY depth,schema_name,table_name
      LOOP
        EXECUTE format('SELECT count(*)::bigint FROM %I.%I',
          affected_table.schema_name,affected_table.table_name) INTO row_count_value;
        best_unproven_count := row_count_value;
        relation_proven := row_count_value=0;

        IF affected_table.guard_kind='SAMPLE_IDEMPOTENCY' THEN
          SELECT count(*)::bigint INTO unproven_count
          FROM gowm_capability.idempotency_record idempotency
          WHERE NOT EXISTS (
            SELECT 1 FROM pg_temp.sample_reset_owned_idempotency owned
            WHERE owned.idempotency_record_id=idempotency.idempotency_record_id
          );
          best_unproven_count := unproven_count;
          relation_proven := unproven_count=0;
        ELSIF affected_table.guard_kind='SAMPLE_EXECUTION_RECEIPT' THEN
          SELECT count(*)::bigint INTO unproven_count
          FROM gowm_capability.execution_receipt receipt
          WHERE NOT EXISTS (
              SELECT 1 FROM pg_temp.sample_reset_owned_idempotency owned
              WHERE owned.receipt_id=receipt.receipt_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM gowm_capability.gateway_job gateway_job
              WHERE gateway_job.job_id=receipt.job_id
                AND gateway_job.data_scope_key IN ('wsgs-demo','wsgs-hidden')
            );
          best_unproven_count := unproven_count;
          relation_proven := unproven_count=0;
        ELSIF affected_table.guard_kind='SAMPLE_GATEWAY_AUDIT' THEN
          SELECT count(*)::bigint INTO unproven_count
          FROM gowm_capability.gateway_audit_event audit_event
          WHERE audit_event.data_scope_hash IS NULL OR NOT EXISTS (
            SELECT 1
            FROM gowm_sample_fixture.instance_marker marker
            CROSS JOIN LATERAL unnest(marker.allowed_data_scopes) AS allowed_scope(scope_key)
            WHERE marker.fixture_id='gowm-wsgs-sample-world'
              AND marker.schema_version='gowm-wsgs-sample-world/1.0'
              AND audit_event.data_scope_hash=
                'sha256:'||encode(
                  public.digest(convert_to(to_jsonb(allowed_scope.scope_key)::text,'UTF8'),'sha256'),
                  'hex'
                )
          );
          best_unproven_count := unproven_count;
          relation_proven := unproven_count=0;
        ELSE
          FOR dependency_edge IN
            SELECT constraint_record.oid,constraint_record.confrelid
            FROM pg_constraint constraint_record
            JOIN pg_temp.sample_reset_affected parent
              ON parent.relation_oid=constraint_record.confrelid
             AND parent.proven_safe
             AND parent.depth<affected_table.depth
            WHERE constraint_record.contype='f'
              AND constraint_record.conrelid=affected_table.relation_oid
            ORDER BY constraint_record.oid
          LOOP
            SELECT string_agg(
              format('child.%I=parent.%I',child_attribute.attname,parent_attribute.attname),
              ' AND ' ORDER BY child_key.ordinality
            ) INTO join_predicate
            FROM pg_constraint constraint_record
            CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY child_key(attribute_number,ordinality)
            JOIN LATERAL unnest(constraint_record.confkey) WITH ORDINALITY parent_key(attribute_number,ordinality)
              ON parent_key.ordinality=child_key.ordinality
            JOIN pg_attribute child_attribute
              ON child_attribute.attrelid=constraint_record.conrelid
             AND child_attribute.attnum=child_key.attribute_number
            JOIN pg_attribute parent_attribute
              ON parent_attribute.attrelid=constraint_record.confrelid
             AND parent_attribute.attnum=parent_key.attribute_number
            WHERE constraint_record.oid=dependency_edge.oid;

            EXECUTE format(
              'SELECT count(*)::bigint FROM %I.%I child WHERE NOT EXISTS (SELECT 1 FROM %s parent WHERE %s)',
              affected_table.schema_name,affected_table.table_name,
              dependency_edge.confrelid::regclass,join_predicate
            ) INTO unproven_count;
            best_unproven_count := LEAST(best_unproven_count,unproven_count);
            IF unproven_count=0 THEN
              relation_proven := true;
              EXIT;
            END IF;
          END LOOP;
        END IF;

        UPDATE pg_temp.sample_reset_affected
        SET rows_before=row_count_value,proven_safe=relation_proven
        WHERE relation_oid=affected_table.relation_oid;
        affected_rows_before := affected_rows_before+row_count_value;
        non_fixture_rows_before := non_fixture_rows_before+best_unproven_count;
        IF NOT relation_proven THEN
          RAISE EXCEPTION 'sample reset cannot prove ownership of % rows in cascade table %.%',
            best_unproven_count,affected_table.schema_name,affected_table.table_name;
        END IF;
      END LOOP;

      CREATE TEMP TABLE sample_reset_processing_run ON COMMIT DROP AS
      SELECT DISTINCT time_solution.processing_run_id
      FROM public.observation_time_solution time_solution
      JOIN public.world_observation observation_record
        ON observation_record.observation_id=time_solution.observation_id
      WHERE observation_record.data_scope_key IN ('wsgs-demo','wsgs-hidden');
      SELECT count(*)::bigint INTO sample_processing_runs_before
      FROM pg_temp.sample_reset_processing_run;
      SELECT count(*)::bigint INTO sample_reference_rows_before
      FROM public.world_reference_identity
      WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden') AND entity_kind<>'DATA_SCOPE';
      SELECT
        (SELECT count(*) FROM public.world_reference_descriptor_version
          WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden'))+
        (SELECT count(*) FROM public.world_reference_name
          WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden'))+
        (SELECT count(*) FROM public.world_reference_external_identifier
          WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden'))+
        (SELECT count(*) FROM public.reference_search_projection
          WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden'))
      INTO sample_reference_catalog_rows_before;
      SELECT count(*)::bigint INTO sample_scope_rows_before
      FROM public.data_scope WHERE scope_key IN ('wsgs-demo','wsgs-hidden');
      SELECT count(*)::bigint INTO protected_rows_before
      FROM public.world_reference_identity
      WHERE data_scope_key NOT IN ('wsgs-demo','wsgs-hidden') OR entity_kind='DATA_SCOPE';
      protected_rows_before := protected_rows_before+
        (SELECT count(*)::bigint FROM public.data_scope);
      protected_rows_before := protected_rows_before+
        (SELECT count(*)::bigint FROM public.world_reference_descriptor_version
          WHERE data_scope_key NOT IN ('wsgs-demo','wsgs-hidden'))+
        (SELECT count(*)::bigint FROM public.world_reference_name
          WHERE data_scope_key NOT IN ('wsgs-demo','wsgs-hidden'))+
        (SELECT count(*)::bigint FROM public.world_reference_external_identifier
          WHERE data_scope_key NOT IN ('wsgs-demo','wsgs-hidden'))+
        (SELECT count(*)::bigint FROM public.reference_search_projection
          WHERE data_scope_key NOT IN ('wsgs-demo','wsgs-hidden'));
      SELECT count(*)::bigint INTO migration_rows_before FROM public.schema_migration;
      SELECT count(*)::bigint INTO marker_rows_before FROM gowm_sample_fixture.instance_marker;
      affected_rows_before := affected_rows_before+sample_processing_runs_before+
        sample_reference_rows_before+sample_reference_catalog_rows_before;

      fixture_counts := jsonb_build_object(
        'objects',(SELECT count(*) FROM world_object WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden')),
        'observations',(SELECT count(*) FROM world_observation WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden')),
        'features',(SELECT count(*) FROM spatial_feature_identity WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden')),
        'datasets',(SELECT count(*) FROM spatial_dataset WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden')),
        'references',(SELECT count(*) FROM world_reference_identity
          WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden')
            AND entity_kind IN ('WORLD_OBJECT','DATASET','LAYER','LAYER_FEATURE')),
        'worldQueries',(SELECT count(*) FROM gowm_capability.world_query_job WHERE data_scope_claim IN ('wsgs-demo','wsgs-hidden')),
        'processingRuns',sample_processing_runs_before,
        'referenceIdentities',sample_reference_rows_before,
        'referenceCatalogRows',sample_reference_catalog_rows_before,
        'dataScopesPreserved',sample_scope_rows_before,
        'affectedTables',(SELECT count(*) FROM pg_temp.sample_reset_affected),
        'affectedRowsBefore',affected_rows_before,
        'nonFixtureRowsBefore',non_fixture_rows_before,
        'protectedRowsBefore',protected_rows_before,
        'migrationRowsBefore',migration_rows_before,
        'markerRowsBefore',marker_rows_before
      );

      IF NOT p_dry_run THEN
        SELECT string_agg(format('%I.%I',schema_name,table_name),',' ORDER BY schema_name,table_name)
        INTO direct_targets
        FROM pg_temp.sample_reset_affected WHERE direct_target;
        IF direct_targets IS NOT NULL THEN
          EXECUTE 'TRUNCATE TABLE '||direct_targets||' CASCADE';
        END IF;
        ALTER TABLE public.processing_run
          DISABLE TRIGGER processing_run_immutable;
        DELETE FROM public.processing_run processing_run_record
        USING pg_temp.sample_reset_processing_run owned_run
        WHERE processing_run_record.processing_run_id=owned_run.processing_run_id;
        ALTER TABLE public.processing_run
          ENABLE TRIGGER processing_run_immutable;
        DELETE FROM public.reference_search_projection
        WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden');
        ALTER TABLE public.world_reference_external_identifier
          DISABLE TRIGGER world_reference_external_identifier_immutable;
        ALTER TABLE public.world_reference_name
          DISABLE TRIGGER world_reference_name_immutable;
        ALTER TABLE public.world_reference_descriptor_version
          DISABLE TRIGGER world_reference_descriptor_version_immutable;
        DELETE FROM public.world_reference_external_identifier
        WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden');
        DELETE FROM public.world_reference_name
        WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden');
        DELETE FROM public.world_reference_descriptor_version
        WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden');
        ALTER TABLE public.world_reference_descriptor_version
          ENABLE TRIGGER world_reference_descriptor_version_immutable;
        ALTER TABLE public.world_reference_name
          ENABLE TRIGGER world_reference_name_immutable;
        ALTER TABLE public.world_reference_external_identifier
          ENABLE TRIGGER world_reference_external_identifier_immutable;
        ALTER TABLE public.world_reference_identity
          DISABLE TRIGGER world_reference_identity_immutable;
        DELETE FROM public.world_reference_identity
        WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden') AND entity_kind<>'DATA_SCOPE';
        ALTER TABLE public.world_reference_identity
          ENABLE TRIGGER world_reference_identity_immutable;
      END IF;

      FOR affected_table IN
        SELECT * FROM pg_temp.sample_reset_affected ORDER BY depth,schema_name,table_name
      LOOP
        EXECUTE format('SELECT count(*)::bigint FROM %I.%I',
          affected_table.schema_name,affected_table.table_name) INTO row_count_value;
        UPDATE pg_temp.sample_reset_affected SET rows_after=row_count_value
        WHERE relation_oid=affected_table.relation_oid;
        affected_rows_after := affected_rows_after+row_count_value;
      END LOOP;
      SELECT count(*)::bigint INTO sample_processing_runs_after
      FROM public.processing_run processing_run_record
      JOIN pg_temp.sample_reset_processing_run owned_run
        ON owned_run.processing_run_id=processing_run_record.processing_run_id;
      SELECT count(*)::bigint INTO sample_reference_rows_after
      FROM public.world_reference_identity
      WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden') AND entity_kind<>'DATA_SCOPE';
      SELECT
        (SELECT count(*) FROM public.world_reference_descriptor_version
          WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden'))+
        (SELECT count(*) FROM public.world_reference_name
          WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden'))+
        (SELECT count(*) FROM public.world_reference_external_identifier
          WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden'))+
        (SELECT count(*) FROM public.reference_search_projection
          WHERE data_scope_key IN ('wsgs-demo','wsgs-hidden'))
      INTO sample_reference_catalog_rows_after;
      SELECT count(*)::bigint INTO sample_scope_rows_after
      FROM public.data_scope WHERE scope_key IN ('wsgs-demo','wsgs-hidden');
      SELECT count(*)::bigint INTO protected_rows_after
      FROM public.world_reference_identity
      WHERE data_scope_key NOT IN ('wsgs-demo','wsgs-hidden') OR entity_kind='DATA_SCOPE';
      protected_rows_after := protected_rows_after+
        (SELECT count(*)::bigint FROM public.data_scope);
      protected_rows_after := protected_rows_after+
        (SELECT count(*)::bigint FROM public.world_reference_descriptor_version
          WHERE data_scope_key NOT IN ('wsgs-demo','wsgs-hidden'))+
        (SELECT count(*)::bigint FROM public.world_reference_name
          WHERE data_scope_key NOT IN ('wsgs-demo','wsgs-hidden'))+
        (SELECT count(*)::bigint FROM public.world_reference_external_identifier
          WHERE data_scope_key NOT IN ('wsgs-demo','wsgs-hidden'))+
        (SELECT count(*)::bigint FROM public.reference_search_projection
          WHERE data_scope_key NOT IN ('wsgs-demo','wsgs-hidden'));
      SELECT count(*)::bigint INTO migration_rows_after FROM public.schema_migration;
      SELECT count(*)::bigint INTO marker_rows_after FROM gowm_sample_fixture.instance_marker;
      affected_rows_after := affected_rows_after+sample_processing_runs_after+
        sample_reference_rows_after+sample_reference_catalog_rows_after;
      non_fixture_rows_after := non_fixture_rows_before;

      IF NOT p_dry_run AND affected_rows_after<>0 THEN
        RAISE EXCEPTION 'sample reset left % rows in the measured fixture impact set',affected_rows_after;
      END IF;
      IF protected_rows_after<>protected_rows_before OR
         migration_rows_after<>migration_rows_before OR marker_rows_after<>marker_rows_before THEN
        RAISE EXCEPTION 'sample reset changed protected rows (protected %->%, migrations %->%, marker %->%)',
          protected_rows_before,protected_rows_after,
          migration_rows_before,migration_rows_after,marker_rows_before,marker_rows_after;
      END IF;

      fixture_counts := fixture_counts||jsonb_build_object(
        'affectedRowsAfter',affected_rows_after,
        'nonFixtureRowsAfter',non_fixture_rows_after,
        'protectedRowsAfter',protected_rows_after,
        'migrationRowsAfter',migration_rows_after,
        'markerRowsAfter',marker_rows_after
      );

      RETURN jsonb_build_object(
        'schemaVersion','1.0',
        'fixtureId','gowm-wsgs-sample-world',
        'dryRun',p_dry_run,
        'databaseMarker','gowm_wsgs_sample/gowm-wsgs-sample-world/1.0',
        'deletedCounts',fixture_counts,
        'nonFixtureRowsAffected',abs(protected_rows_before-protected_rows_after)+
          abs(migration_rows_before-migration_rows_after)+abs(marker_rows_before-marker_rows_after),
        'status','PASS'
      );
    END
    $function$;
    REVOKE ALL ON FUNCTION gowm_sample_fixture.reset_sample_world(boolean) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION gowm_sample_fixture.reset_sample_world(boolean)
      TO gowm_sample_loader_service;
  `;

function assertSampleDatabase(connectionString: string | undefined): void {
  const parsed = new URL(requiredValue(connectionString, "DATABASE_URL"));
  if (parsed.pathname !== "/gowm_wsgs_sample") {
    throw new Error("Refusing to bootstrap outside the isolated gowm_wsgs_sample database");
  }
}

async function installInstanceMarker(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS gowm_sample_fixture;
    REVOKE ALL ON SCHEMA gowm_sample_fixture FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS gowm_sample_fixture.instance_marker (
      fixture_id text PRIMARY KEY,
      schema_version text NOT NULL,
      allowed_data_scopes text[] NOT NULL,
      installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK (fixture_id = 'gowm-wsgs-sample-world'),
      CHECK (schema_version = 'gowm-wsgs-sample-world/1.0'),
      CHECK (allowed_data_scopes = ARRAY['wsgs-demo','wsgs-hidden']::text[])
    );
    INSERT INTO gowm_sample_fixture.instance_marker(fixture_id,schema_version,allowed_data_scopes)
    VALUES ('gowm-wsgs-sample-world','gowm-wsgs-sample-world/1.0',ARRAY['wsgs-demo','wsgs-hidden'])
    ON CONFLICT (fixture_id) DO NOTHING;
  `);
}

export const SAMPLE_LOADER_REQUIRED_ACL_SQL = String.raw`
      GRANT SELECT ON TABLE
        tracklet_rule_profile,mobility_tracklet_version
      TO gowm_sample_loader_service;
      GRANT INSERT ON TABLE
        mobility_tracklet_version,mobility_tracklet_segment,mobility_tracklet_gap,
        mobility_tracklet_input,mobility_tracklet_lineage
      TO gowm_sample_loader_service;
      GRANT DELETE ON TABLE object_area_membership TO gowm_sample_loader_service;
      GRANT EXECUTE ON FUNCTION
        gowm_tracklet_candidates(text,text,text,text,text,text),
        gowm_rebuild_mobility_tracklet(text,text,text,text,text,text)
      TO gowm_sample_loader_service;
`;

async function provisionLoader(pool: pg.Pool): Promise<void> {
  const password = required("SAMPLE_LOADER_DB_PASSWORD");
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(password)) {
    throw new Error("SAMPLE_LOADER_DB_PASSWORD must contain 32-128 URL-safe characters");
  }
  await pool.query("SELECT set_config('gowm.sample_loader_password',$1,false)", [password]);
  try {
    await pool.query(`
      DO $roles$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gowm_sample_loader_service') THEN
          CREATE ROLE gowm_sample_loader_service LOGIN NOINHERIT;
        END IF;
        EXECUTE format(
          'ALTER ROLE gowm_sample_loader_service LOGIN PASSWORD %L',
          current_setting('gowm.sample_loader_password')
        );
      END
      $roles$;
      ALTER ROLE gowm_sample_loader_service SET statement_timeout = '120s';
      ALTER ROLE gowm_sample_loader_service SET search_path = public;
      REVOKE ALL ON SCHEMA public,gowm_sample_fixture FROM gowm_sample_loader_service;
      GRANT USAGE ON SCHEMA public,gowm_sample_fixture TO gowm_sample_loader_service;
      GRANT SELECT ON gowm_sample_fixture.instance_marker TO gowm_sample_loader_service;
      GRANT SELECT,INSERT,UPDATE ON TABLE
        data_scope,analysis_space,source_registry,producer_pipeline,datastream,processing_run,
        source_clock_model,world_object,world_object_state,world_object_geometry,world_observation,
        projection_queue,world_event,world_observation_head,observation_time_solution,measurement,
        position_measurement,observation_assertion,entity_binding,foundation_processing_receipt,
        mobility_tracklet,mobility_tracklet_head,
        situation_cell,situation_cell_observer,object_area_membership,
        spatial_dataset,spatial_dataset_version,spatial_layer,spatial_layer_version,
        spatial_feature_identity,spatial_feature_version,world_reference_identity,
        world_reference_descriptor_version,world_reference_name,
        world_reference_external_identifier,reference_search_projection
      TO gowm_sample_loader_service;
      GRANT USAGE,SELECT ON SEQUENCE world_version_seq,
        world_reference_descriptor_version_descriptor_version_seq
      TO gowm_sample_loader_service;
      GRANT EXECUTE ON FUNCTION normalize_reference_text(text) TO gowm_sample_loader_service;
      GRANT EXECUTE ON FUNCTION rebuild_reference_search_projection(text) TO gowm_sample_loader_service;
      ${SAMPLE_LOADER_REQUIRED_ACL_SQL}
    `);
  } finally {
    await pool.query("SELECT set_config('gowm.sample_loader_password','',false)");
  }
}

function required(name: string): string {
  return requiredValue(process.env[name], name);
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  bootstrapWsgsSample().then(
    () => process.stdout.write("WSGS_SAMPLE_BOOTSTRAP_READY\n"),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}

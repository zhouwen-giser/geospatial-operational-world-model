BEGIN;
CREATE TABLE public.world_event_feed_pending (
 event_id uuid PRIMARY KEY REFERENCES public.world_event(event_id),
 data_scope_key text NOT NULL REFERENCES public.data_scope(scope_key),queued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX world_event_feed_pending_scope_idx ON public.world_event_feed_pending(data_scope_key,queued_at,event_id);
CREATE TABLE public.world_event_feed_counter (
 data_scope_key text PRIMARY KEY REFERENCES public.data_scope(scope_key),position bigint NOT NULL DEFAULT 0 CHECK(position>=0)
);
CREATE TABLE public.world_event_feed (
 data_scope_key text NOT NULL REFERENCES public.data_scope(scope_key),position bigint NOT NULL CHECK(position>0),
 event_id uuid NOT NULL UNIQUE REFERENCES public.world_event(event_id),appended_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(data_scope_key,position)
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_event_feed_writer') THEN CREATE ROLE gowm_event_feed_writer NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_event_feed_reader') THEN CREATE ROLE gowm_event_feed_reader NOLOGIN; END IF;
END $$;
CREATE FUNCTION public.enqueue_world_event_feed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO public.world_event_feed_pending(event_id,data_scope_key) VALUES(NEW.event_id,NEW.data_scope_key) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER world_event_feed_enqueue AFTER INSERT ON public.world_event
 FOR EACH ROW EXECUTE FUNCTION public.enqueue_world_event_feed();
-- CREATE TRIGGER holds the table lock until this backfill commits: no installation gap.
INSERT INTO public.world_event_feed_pending(event_id,data_scope_key) SELECT event_id,data_scope_key FROM public.world_event ON CONFLICT DO NOTHING;
CREATE FUNCTION public.append_world_event_feed(p_scope text,p_limit integer DEFAULT 500) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE initial_position bigint; appended integer;
BEGIN
 IF p_limit<1 OR p_limit>1000 THEN RAISE EXCEPTION 'EVENT_FEED_BATCH_INVALID'; END IF;
 INSERT INTO public.world_event_feed_counter(data_scope_key) VALUES(p_scope) ON CONFLICT DO NOTHING;
 SELECT position INTO initial_position FROM public.world_event_feed_counter WHERE data_scope_key=p_scope FOR UPDATE;
 -- Per-scope counter lock serializes publication, rather than preallocating a sequence
 -- in transactions which can commit out of order. Pending rows are already committed.
 WITH chosen AS MATERIALIZED (
  SELECT p.event_id,p.queued_at FROM public.world_event_feed_pending p
   WHERE p.data_scope_key=p_scope ORDER BY p.queued_at,p.event_id LIMIT p_limit FOR UPDATE
 ), inserted AS (
  INSERT INTO public.world_event_feed(data_scope_key,position,event_id)
   SELECT p_scope,initial_position+row_number() OVER(ORDER BY queued_at,event_id),event_id FROM chosen
   RETURNING event_id
 ) DELETE FROM public.world_event_feed_pending p USING inserted i WHERE p.event_id=i.event_id;
 GET DIAGNOSTICS appended=ROW_COUNT;
 UPDATE public.world_event_feed_counter SET position=initial_position+appended WHERE data_scope_key=p_scope;
 IF appended>0 THEN PERFORM pg_notify('gowm_event_feed',p_scope); END IF;
 RETURN appended;
END $$;
REVOKE ALL ON public.world_event_feed,public.world_event_feed_pending,public.world_event_feed_counter FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_world_event_feed(),public.append_world_event_feed(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.append_world_event_feed(text,integer) TO gowm_event_feed_writer;
GRANT SELECT ON public.world_event_feed_pending,public.data_scope TO gowm_event_feed_writer;
GRANT SELECT ON public.world_event_feed,public.world_event TO gowm_event_feed_reader;
COMMIT;

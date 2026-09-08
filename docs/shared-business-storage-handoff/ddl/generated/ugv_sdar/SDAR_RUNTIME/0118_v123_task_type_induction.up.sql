ALTER TABLE ugv_sdar.task_type_definition 
  ADD COLUMN definition_origin text
    NOT NULL
    DEFAULT 'reflection_candidate'
    CHECK (definition_origin IN ('reflection_candidate', 'task_type_induction', 'fixture')),
  ADD COLUMN model_invocation_id text
    REFERENCES ugv_sdar.model_invocation (invocation_id);

CREATE INDEX task_type_definition_candidate_fingerprint_idx ON ugv_sdar.task_type_definition (fingerprint, revision DESC, knowledge_id) WHERE status = 'candidate';

ALTER TABLE ugv_sdar.stage_model_route 
  DROP CONSTRAINT stage_model_route_stage_check RESTRICT;

ALTER TABLE ugv_sdar.stage_model_route 
  ADD CONSTRAINT stage_model_route_stage_check 
    CHECK (stage IN ('intent', 'goal', 'goal_planning', 'tool_enhancement', 'skill_authoring', 'skill_selection', 'skill_input_resolution', 'workflow_planning', 'execution_decision', 'goal_evaluation', 'evaluation', 'result_processing', 'task_understanding', 'task_clarification', 'goal_contract_generation', 'interactive_plan_patch', 'experience_observation', 'experience_reflection', 'task_type_induction'));

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0118_v123_task_type_induction');

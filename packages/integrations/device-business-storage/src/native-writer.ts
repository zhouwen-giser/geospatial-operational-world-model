import type { PoolClient } from 'pg';

/** Storage primitive only: the owning application still performs admission/MCP
 * calls and supplies every native business field in its existing transaction.
 * The fixture uses this same bounded writer; no alternate shadow Task exists. */
const tables = [
  'ugv_sdar.conversation_context', 'ugv_sdar.goal', 'ugv_sdar.agent_task',
  'ugv_sdar.workflow_plan', 'ugv_sdar.workflow_instance', 'ugv_sdar.workflow_node_event',
  'ugv_sdar.mcp_invocation', 'ugv_sdar.remote_task_binding',
  'ugv_sdar.task_capability_binding', 'ugv_sdar.task_capability_execution_attempt',
  'ugv_sdar.initial_task_admission',
  'ugv_smpp.operation_snapshot', 'ugv_smpp.provider_task', 'ugv_smpp.ugv_execution',
  'ugv_smpp.ugv_mutation_journal', 'ugv_smpp.ugv_state_snapshot',
  'ugv_smpp.ugv_business_event_source_state', 'ugv_smpp.ugv_business_event_source_log',
  'ugv_smpp.idempotency_record', 'ugv_smpp.task_command', 'ugv_smpp.ugv_execution_command_ack'
] as const;
export type NativeTable = typeof tables[number];
const deviceTables = new Set<string>(tables.filter(t => ![
  'ugv_sdar.conversation_context','ugv_sdar.goal','ugv_smpp.operation_snapshot',
  'ugv_sdar.task_capability_binding','ugv_sdar.task_capability_execution_attempt'
].includes(t)));
export async function insertNativeRecord(c: PoolClient, table: NativeTable, values: Record<string, unknown>): Promise<void> {
  if (!(tables as readonly string[]).includes(table)) throw Error('NATIVE_TABLE_NOT_ALLOWED');
  const keys = Object.keys(values);
  if (!keys.length || keys.some(k => !/^[a-z][a-z0-9_]*$/.test(k))) throw Error('NATIVE_COLUMN_INVALID');
  if (deviceTables.has(table) && (typeof values.device_id !== 'string' || !values.device_id.trim())) throw Error('DEVICE_ID_REQUIRED');
  await c.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`, Object.values(values));
}

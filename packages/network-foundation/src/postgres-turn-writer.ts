import type { PoolClient } from "pg";
import type { CompiledTurnRestrictions } from "./types.js";

type TurnTransaction = Pick<PoolClient, "query">;

export interface PersistNetworkTurnsRequest {
  readonly graphVersionId: string;
  readonly dataScopeKey: string;
  readonly compiled: CompiledTurnRestrictions;
  readonly nodeIdsByKey: ReadonlyMap<string, string>;
  readonly arcIdsByKey: ReadonlyMap<string, string>;
}

export class PostgresNetworkTurnWriter {
  constructor(private readonly database: TurnTransaction) {}

  async persist(request: PersistNetworkTurnsRequest): Promise<void> {
    for (const rule of request.compiled.pairwiseRules) {
      const fromArcId = request.arcIdsByKey.get(rule.fromArcKey);
      const viaNodeId = request.nodeIdsByKey.get(rule.viaNodeKey);
      const toArcId = request.arcIdsByKey.get(rule.toArcKey);
      if (!fromArcId || !viaNodeId || !toArcId) throw new Error("pairwise turn rule references unavailable topology");
      await this.database.query(
        `INSERT INTO network_turn_rule(
           graph_version_id,data_scope_key,rule_key,from_arc_id,via_node_id,to_arc_id,
           rule_type,penalty_units,profile_filter,evidence,content_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
        [request.graphVersionId, request.dataScopeKey, rule.ruleKey, fromArcId, viaNodeId, toArcId,
          rule.ruleType, rule.penaltyUnits, JSON.stringify(rule.profileFilter), JSON.stringify(rule.evidence), rule.contentHash]
      );
    }
    for (const rule of request.compiled.sequenceRules) {
      const arcIds = rule.arcSequence.map((arcKey) => request.arcIdsByKey.get(arcKey));
      if (arcIds.some((arcId) => arcId === undefined)) throw new Error("sequence turn rule references unavailable topology");
      await this.database.query(
        `INSERT INTO network_turn_sequence_rule(
           graph_version_id,data_scope_key,rule_key,arc_sequence,rule_type,penalty_units,
           profile_filter,evidence,automaton_hash,content_hash
         ) VALUES ($1,$2,$3,$4::bigint[],$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
        [request.graphVersionId, request.dataScopeKey, rule.ruleKey, arcIds, rule.ruleType,
          rule.penaltyUnits, JSON.stringify(rule.profileFilter), JSON.stringify(rule.evidence),
          rule.automatonHash, rule.contentHash]
      );
    }
  }
}

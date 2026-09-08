# G05 — 目标图形：两张公共表

## gowm_task.target_geometry

- target_id uuid PK：精确目标修订。
- target_group_id uuid；revision int>0；UNIQUE(target_group_id,revision)。
- data_scope_key FK。
- source_domain：SDAR / SMPP / UGV_PROVIDER / GOWM_USER；不保存storeId。
- source_record_identity jsonb：完整稳定来源ID，仅来源说明，不复制Task状态。
- geometry_kind：POINT/LINESTRING/POLYGON及对应MULTI类型。
- native_geometry jsonb object；native_crs text（未知时明确未指定）。
- geometry_wgs84 geometry(Geometry,4326) NULL。
- normalization_state：NATIVE_ONLY / NORMALIZED / INVALID。
- transform_info jsonb；supersedes_target_id；created_at。

规范：
1. 标准化图形必须类型正确、非空、有效且坐标范围正确。
2. NORMALIZED时才有geometry_wgs84；本轮不做新的CRS推断服务。
3. ST_SetSRID只声明坐标含义，不进行转换；不把未知x/y标为WGS84。
4. 图形不是设备当前位置：不写world_object_geometry当作真实到达位置。
5. 同一目标修订不可覆盖geometry/CRS/来源；变化创建新修订。
6. supersedes必须同group、同scope，修订顺序一致。
7. 同区域可被两设备任务引用，geometry本身不强制属于一台设备；使用关系必须符合scope。

## gowm_task.target_binding

- target_binding_id uuid PK；target_id FK。
- device_id（设备使用必填）；data_scope_key。
- owner_domain：SDAR / SMPP / UGV_PROVIDER。
- owner_kind：TASK / PLAN_NODE / NODE_RUN / MCP_TASK / PROVIDER_DISPATCH。
- owner_key jsonb object：完整原生身份；使用JSONB结构不靠namespace:id无界拼接。
- usage_role：REQUESTED / PLANNED / DISPATCHED。
- target_purpose：MOVE_DESTINATION / OBSERVATION_AREA / ROUTE / 其他明确业务语义。
- argument_path：实际JSON输入字段路径；created_at。
- UNIQUE(owner_domain,owner_kind,owner_key,usage_role,argument_path)。
  重复写同一target_id幂等；同一精确owner输入改绑另一个target_id报冲突。计划变化以新的Plan修订/Node Run/派发Step owner_key记录，不能覆盖已派发绑定。

固定Schema允许按白名单owner_kind验证真实表：
TASK → ugv_sdar.agent_task；
MCP_TASK → ugv_smpp.provider_task；
PROVIDER_DISPATCH → ugv_smpp.ugv_mutation_journal及execution；
Plan/Node Run按当前原生结构映射。

不要在CHECK里执行跨表查询。写入函数/Repository在同事务中验证owner存在、device与scope一致。
不是每个多态owner都能用一个普通FK完成；函数必须实际实现并测试，不能只留TODO。
临时未安装某个business domain时，不开放该domain写入；单独公共建表允许完成，不伪造owner。

## 保留完整目标链

Task要求 → Plan采用 → Node Run实际输入 → MCP arguments → Provider dispatch arguments。
可确认同一目标时复用同一target_id；转换后目标不同则保存新修订或明确派发目标。
保留原生arguments JSON，不自动扫描历史JSON回填、不根据相近坐标猜关联。

禁止对已派发目标“原地更新”，造成历史Mission的目标悄然变化。

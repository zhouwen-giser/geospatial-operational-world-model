import mqtt from "mqtt";

const rawUrl = process.env.UGV_MQTT_FIXTURE_BROKER_URL;
if (!rawUrl) throw new Error("UGV_MQTT_FIXTURE_BROKER_URL is required");
const broker = new URL(rawUrl);
if (!["mqtt:","mqtts:","ws:","wss:"].includes(broker.protocol) || broker.username || broker.password) {
  throw new Error("fixture broker URL must use MQTT without embedded credentials");
}
const client = await mqtt.connectAsync(broker.toString(),{
  protocolVersion: 5,clean: true,clientId: `gowm-ugv-fixture-publisher-${process.pid}`,reconnectPeriod: 0
});

const publish = async (topic: string,value: unknown,options: { retain?: boolean } = {}): Promise<void> => {
  await client.publishAsync(topic,typeof value === "string" ? value : JSON.stringify(value),{
    qos: 1,retain: options.retain ?? false
  });
  await new Promise((resolve) => setTimeout(resolve,30));
};
try {
  await publish("/ugv/gnss",{ latitude: 29.7195,longitude: 106.81485,altitude: 500 },{ retain: true });
  await publish("/ugv/gnss",{ latitude: 29.71951,longitude: 106.81486,altitude: 500.2 });
  await publish("/ugv/gnss",{ latitude: 29.71952,longitude: 106.81487,altitude: 500.4 });
  await publish("/ugv/gnss","{invalid-json");
  await publish("/ugv/speed",{ data: 0 });
  await publish("/ugv/speed",{ data: 18 });
  await publish("/ugv/speed",{ data: 18 });
  await publish("status/ugv",{ available: false });
  await publish("status/ugv",{ available: true,lvbattery_soc: 89,hvbattery1_soc: 80,hvbattery2_soc: 81,
    fuel1: 70,fuel2: 71,motor_temp: 42,engine_water_temp: 55,ready_status: 1,gear_status: 2,brake_status: 0,
    emergency_stop_status: 0,heading: 90,roll: 0,pitch: 1,ins_init: 1,gnss: 1,location_status: 1,
    power_supply_status: 1,operate_mode_status: 2,fault: null,ping_status: 1,packet_loss_rate: 0.1,
    average_round_trip_time: 12,veh_speed: 18,chassis_task: { state: 1 },eo_task: { state: 5 } });
  for (const [state,progress] of [[0,0],[1,10],[2,30],[1,35],[4,100]] as const) {
    await publish("/ugv/mission_state",{ entity_id: "ugv",id: 42,type: 1,state,progress });
  }
  for (const status of [2,3,4,5] as const) {
    await publish("/ugv/area_recon/status",{ status,status_label: `status-${status}`,progress: status === 5 ? 20 : 0,
      coverage: status === 5 ? 10 : 0,camera_fault: false,out_of_range: false });
  }
  const target = (id: number,lockTime = 0) => ({ capture_time_us: 1_757_000_000_000_000+id,target_id: id,type: 2,
    position: { longitude: 106.8149+id/1_000_000,latitude: 29.71955+id/1_000_000,altitude: 501 },
    velocity: { vel_e: 1,vel_n: 0,vel_u: 0 },distance: 20+id,confidence: 0.9,threat: 2,damage: 0,iff: 1,
    lock_time: lockTime,pixel_pos: { x: 10,y: 20,theta: 0,w: 30,h: 40 },role_name: `target-${id}` });
  await publish("/ugv/area_recon/targets",{ targets: [target(101),target(102)] });
  await publish("/ugv/area_recon/targets",{ targets: [target(101,1),target(102)] });
  await publish("/ugv/area_recon/targets",{ targets: [] });
  await publish("/ugv/area_recon/status",{ status: 5,status_label: "运行中",progress: 20,coverage: 10,camera_fault: true });
  await publish("/ugv/area_recon/targets",{ targets: [target(103)] });
  await publish("/ugv/area_recon/targets",{ targets: [] });
  await publish("/ugv/area_recon/status",{ status: 8,status_label: "已暂停",progress: 20,coverage: 10,camera_fault: false });
  await publish("/ugv/area_recon/targets",{ targets: [] });
  for (const status of [6,5,11] as const) {
    await publish("/ugv/area_recon/status",{ status,status_label: `status-${status}`,progress: status === 11 ? 100 : 20,
      coverage: status === 11 ? 100 : 10,camera_fault: false });
  }
  await publish("/ugv/area_recon/exception",{ kind: "equipment",level: 1,error_code: 1,time_us: 1_757_000_000_000_999,
    target_info: { reason: "consumer-harness camera fault" } });
  process.stdout.write(`${JSON.stringify({ status: "PUBLISHED",marker: "UGV_MQTT_CONSUMER_HARNESS_FIXTURES" })}\n`);
} finally {
  await client.endAsync();
}

export interface Sensor {
  id: number;
  sensor_number: number;
  name: string;
  raw_reading: number;
  reading: number;
  type: string;
  type_number: number;
  sensor_state: number;
  discrete_state: number;
  accessible: number;
  lower_non_recoverable_threshold: number | 'NA';
  lower_critical_threshold: number | 'NA';
  lower_non_critical_threshold: number | 'NA';
  higher_non_critical_threshold: number | 'NA';
  higher_critical_threshold: number | 'NA';
  higher_non_recoverable_threshold: number | 'NA';
  unit: string;
}

export interface ChassisStatus {
  power_status: number;
  led_status: number;
}

export interface FirmwareInfo {
  fw_ver: string;
  date: string;
  time: string;
  active_image: number;
  bios_ver: string;
}

export interface Uptime {
  minutes_per_count: number;
  poh_counter_reading: number;
}

export interface FanProfile {
  strVersion: string;
  strName: string;
  arrPolicy: FanPolicy[];
}

export interface FanPolicy {
  iPolicyType: number;
  iInSDR: number;
  iSensorCode: number;
  iInitDuty: number;
  iCpuTdp: number;
  iAmbientSensor: number;
  iAmbientSensorTemp: number;
  arrSensor: number[];
  arrFanSensor: number[];
  arrRef: number[];
  arrDuty: number[];
}

export interface SelEvent {
  id: number;
  record_type: string;
  timestamp: number;
  sensor_name: string;
  sensor_number: number;
  event_direction?: number;
  description?: string;
  [key: string]: unknown;
}

export type Position = [longitude: number, latitude: number];

export interface Building {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  footprint: Position[];
  height_m: number;
  elevation_m: number;
  roof_condition: "good" | "fair" | "poor";
  property_type: "residential" | "senior_housing" | "commercial" | "mixed";
  units: number;
  tenants: number;
  floors: number;
  elevators: number;
  construction_type: string;
  manager: { name: string; phone: string };
  egress: { stairwells: number; exits: number; fire_escapes: number; ladder_windows: number };
}

export interface DemoRisk {
  exposure: number;
  evacuationDifficulty: number;
  urgency: number;
}

export type MapBuilding = Pick<Building, "id" | "name" | "lat" | "lng" | "height_m"> & {
  footprint?: Position[];
  demoRisk?: DemoRisk;
};

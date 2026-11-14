import type { MapBuilding } from "./types";

export const demoBuildings: MapBuilding[] = [
  {
    id: "juniper",
    name: "Juniper Senior Living",
    lat: 34.10162,
    lng: -118.33114,
    height_m: 36,
    demoRisk: { exposure: 1, evacuationDifficulty: 0.97, urgency: 0.94 },
  },
  {
    id: "sycamore",
    name: "Sycamore Apartments",
    lat: 34.10099,
    lng: -118.33147,
    height_m: 28,
    footprint: [
      [-118.33166, 34.10089],
      [-118.33129, 34.10089],
      [-118.33129, 34.10109],
      [-118.33166, 34.10109],
    ],
    demoRisk: { exposure: 0.84, evacuationDifficulty: 0.86, urgency: 0.83 },
  },
  {
    id: "birch",
    name: "Birch Apartments",
    lat: 34.10148,
    lng: -118.332,
    height_m: 18,
    demoRisk: { exposure: 0.82, evacuationDifficulty: 0.79, urgency: 0.81 },
  },
  {
    id: "pine",
    name: "Pine Condos",
    lat: 34.10068,
    lng: -118.33092,
    height_m: 48,
    demoRisk: { exposure: 0.77, evacuationDifficulty: 0.71, urgency: 0.62 },
  },
  {
    id: "magnolia",
    name: "Magnolia Office Center",
    lat: 34.10119,
    lng: -118.33052,
    height_m: 54,
    demoRisk: { exposure: 0.63, evacuationDifficulty: 0.43, urgency: 0.51 },
  },
  {
    id: "cypress",
    name: "Cypress Plaza",
    lat: 34.10061,
    lng: -118.33192,
    height_m: 12,
    demoRisk: { exposure: 0.37, evacuationDifficulty: 0.39, urgency: 0.27 },
  },
];

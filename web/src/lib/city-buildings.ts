import type { MapBuilding } from "./types";

export const cityBuildingCount = 40_000;

export function createCityBuildings(): MapBuilding[] {
  const side = 200;
  const centerLat = 34.101;
  const centerLng = -118.331;
  const latStep = 42 / 111_320;
  const lngStep = latStep / Math.cos(centerLat * Math.PI / 180);
  let seed = 42;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 2 ** 32;
  };

  return Array.from({ length: cityBuildingCount }, (_, index) => {
    const row = Math.floor(index / side);
    const column = index % side;
    const lat = centerLat + (row - (side - 1) / 2 + (random() - 0.5) * 0.3) * latStep;
    const lng = centerLng + (column - (side - 1) / 2 + (random() - 0.5) * 0.3) * lngStep;
    const exposure = 0.3 + 0.7 * (1 - Math.abs(column - row) / (side - 1));

    return {
      id: `mock-${index + 1}`,
      name: `Building ${index + 1}`,
      lat,
      lng,
      height_m: Math.round(5 + 55 * random() ** 2),
      demoRisk: {
        exposure,
        evacuationDifficulty: 0.2 + 0.8 * random(),
        urgency: 1 - 0.85 * row / (side - 1),
      },
    };
  });
}

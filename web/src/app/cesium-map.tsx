"use client";

import { useEffect, useRef, useState } from "react";
import type { Cartesian3 as Cartesian, Entity } from "cesium";
import { demoScore, riskColor } from "../lib/buildings";
import type { MapBuilding } from "../lib/types";

type Cesium = typeof import("cesium");
type CesiumWindow = Window & { CESIUM_BASE_URL?: string };

function footprint(cesium: Cesium, building: MapBuilding): Cartesian[] {
  const { Cartesian3, Matrix4, Transforms } = cesium;
  if (building.footprint && building.footprint.length >= 3) {
    return building.footprint.map(([lng, lat]) => Cartesian3.fromDegrees(lng, lat));
  }

  const center = Cartesian3.fromDegrees(building.lng, building.lat);
  const localFrame = Transforms.eastNorthUpToFixedFrame(center);
  return [[-13, -10], [13, -10], [13, 10], [-13, 10]].map(([east, north]) =>
    Matrix4.multiplyByPoint(localFrame, new Cartesian3(east, north, 0), new Cartesian3()),
  );
}

export default function CesiumMap({
  buildings,
  activeId,
  onSelect,
}: {
  buildings: MapBuilding[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<InstanceType<Cesium["Viewer"]> | null>(null);
  const entityMap = useRef(new Map<string, Entity>());
  const activeIdRef = useRef(activeId);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    activeIdRef.current = activeId;
    if (viewerRef.current) {
      viewerRef.current.selectedEntity = activeId ? entityMap.current.get(activeId) : undefined;
      viewerRef.current.scene.requestRender();
    }
  }, [activeId]);

  useEffect(() => {
    let stopped = false;
    let viewer: InstanceType<Cesium["Viewer"]> | undefined;
    let handler: InstanceType<Cesium["ScreenSpaceEventHandler"]> | undefined;
    const entities = new Map<string, Entity>();
    (window as CesiumWindow).CESIUM_BASE_URL = "/cesium/";

    async function renderBuildings() {
      const cesium = await import("cesium");
      if (stopped || !container.current) return;

      const { Viewer, Color, Cartesian2, Cartesian3, BoundingSphere, HeadingPitchRange,
        LabelStyle, VerticalOrigin, ScreenSpaceEventHandler, ScreenSpaceEventType, PolygonHierarchy } = cesium;

      viewer = new Viewer(container.current, {
        baseLayer: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        navigationHelpButton: false,
        sceneModePicker: false,
        timeline: false,
        animation: false,
        fullscreenButton: false,
        infoBox: false,
        skyBox: false,
        skyAtmosphere: false,
        requestRenderMode: true,
      });
      viewerRef.current = viewer;
      entityMap.current = entities;
      viewer.scene.globe.baseColor = Color.fromCssColorString("#182937");
      viewer.scene.backgroundColor = Color.fromCssColorString("#182937");

      const positions: Cartesian[] = [];
      for (const building of buildings) {
        const position = Cartesian3.fromDegrees(building.lng, building.lat, building.height_m + 4);
        positions.push(position);
        const color = Color.fromCssColorString(riskColor(building.demoRisk));
        entities.set(building.id, viewer.entities.add({
          id: building.id,
          name: building.name,
          position,
          polygon: {
            hierarchy: new PolygonHierarchy(footprint(cesium, building)),
            height: 0,
            extrudedHeight: building.height_m,
            material: color,
            outline: true,
            outlineColor: color,
          },
          label: {
            text: building.demoRisk ? demoScore(building.demoRisk).toFixed(1) : "–",
            font: "600 15px sans-serif",
            fillColor: color,
            backgroundColor: Color.fromCssColorString("#10212d"),
            backgroundPadding: new Cartesian2(8, 5),
            pixelOffset: new Cartesian2(0, -6),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            showBackground: true,
            style: LabelStyle.FILL,
            verticalOrigin: VerticalOrigin.BOTTOM,
          },
        }));
      }

      if (positions.length) {
        const bounds = BoundingSphere.fromPoints(positions);
        viewer.camera.viewBoundingSphere(bounds, new HeadingPitchRange(0.3, -0.65, Math.max(170, bounds.radius * 3.2)));
        viewer.camera.lookAtTransform(cesium.Matrix4.IDENTITY);
      }

      const currentViewer = viewer;
      handler = new ScreenSpaceEventHandler(currentViewer.scene.canvas);
      handler.setInputAction(({ position }: { position: InstanceType<Cesium["Cartesian2"]> }) => {
        const picked = currentViewer.scene.pick(position);
        const entity = picked?.id;
        if (entity instanceof cesium.Entity && entities.has(entity.id)) onSelect(entity.id);
      }, ScreenSpaceEventType.LEFT_CLICK);
      const id = activeIdRef.current;
      currentViewer.selectedEntity = id ? entities.get(id) : undefined;
      setStatus("ready");
    }

    renderBuildings().catch(() => {
      if (!stopped) setStatus("error");
    });

    return () => {
      stopped = true;
      handler?.destroy();
      viewer?.destroy();
      viewerRef.current = null;
    };
  }, [buildings, onSelect]);

  return (
    <div className="map-view">
      <div className="map-canvas" ref={container} aria-label="Interactive 3D building map" />
      {status === "loading" && <p className="map-message" role="status">Loading 3D map…</p>}
      {status === "error" && (
        <p className="map-message" role="status">The 3D map could not load. Buildings are still available in the list.</p>
      )}
    </div>
  );
}

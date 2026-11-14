"use client";

import { useEffect, useRef, useState } from "react";
import type { Cartesian3 as Cartesian, Color as CesiumColor, Entity, Viewer } from "cesium";
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

function addCityGeometry(cesium: Cesium, viewer: Viewer, buildings: MapBuilding[]) {
  const { BoxGeometry, Cartesian3, Color, ColorGeometryInstanceAttribute, GeometryInstance,
    Matrix4, PerInstanceColorAppearance, Primitive, Transforms } = cesium;
  const geometry = BoxGeometry.createGeometry(BoxGeometry.fromDimensions({
    dimensions: new Cartesian3(26, 20, 1),
    vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
  }));
  if (!geometry) throw new Error("Unable to create mock building geometry");
  const colors = new Map<string, CesiumColor>();
  const primitives = [];
  for (let start = 0; start < buildings.length; start += 2000) {
    const instances = buildings.slice(start, start + 2000).map((building) => {
      const origin = Cartesian3.fromDegrees(building.lng, building.lat, building.height_m / 2);
      const matrix = Transforms.eastNorthUpToFixedFrame(origin);
      Matrix4.multiplyByScale(matrix, new Cartesian3(1, 1, building.height_m), matrix);
      const riskHex = riskColor(building.demoRisk);
      let color = colors.get(riskHex);
      if (!color) {
        color = Color.fromCssColorString(riskHex);
        colors.set(riskHex, color);
      }
      return new GeometryInstance({
        geometry,
        id: building.id,
        modelMatrix: matrix,
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
      });
    });
    primitives.push(viewer.scene.primitives.add(new Primitive({
      geometryInstances: instances,
      appearance: new PerInstanceColorAppearance({ flat: true, translucent: false, closed: true }),
      asynchronous: false,
    })));
  }
  return primitives;
}

export default function CesiumMap({
  buildings,
  batched,
  activeId,
  onSelect,
}: {
  buildings: MapBuilding[];
  batched: boolean;
  activeId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<InstanceType<Cesium["Viewer"]> | null>(null);
  const entityMap = useRef(new Map<string, Entity>());
  const updateCityLabel = useRef<((id: string | undefined) => void) | undefined>(undefined);
  const activeIdRef = useRef(activeId);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    activeIdRef.current = activeId;
    updateCityLabel.current?.(activeId);
    if (viewerRef.current) {
      viewerRef.current.selectedEntity = activeId ? entityMap.current.get(activeId) : undefined;
      viewerRef.current.scene.requestRender();
    }
  }, [activeId]);

  useEffect(() => {
    let stopped = false;
    let viewer: InstanceType<Cesium["Viewer"]> | undefined;
    let handler: InstanceType<Cesium["ScreenSpaceEventHandler"]> | undefined;
    let removeRenderListener: (() => void) | undefined;
    const entities = new Map<string, Entity>();
    (window as CesiumWindow).CESIUM_BASE_URL = "/cesium/";

    async function renderBuildings() {
      const cesium = await import("cesium");
      if (stopped || !container.current) return;

      const { Viewer, Color, Cartesian2, Cartesian3, BoundingSphere, HeadingPitchRange, LabelCollection,
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

      const labelStyle = {
        font: "600 15px sans-serif",
        backgroundColor: Color.fromCssColorString("#10212d"),
        backgroundPadding: new Cartesian2(8, 5),
        pixelOffset: new Cartesian2(0, -6),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        style: LabelStyle.FILL,
        verticalOrigin: VerticalOrigin.BOTTOM,
      };
      const roofPosition = (building: MapBuilding) =>
        Cartesian3.fromDegrees(building.lng, building.lat, building.height_m + 4);
      const byId = new Map(buildings.map((building) => [building.id, building]));
      if (batched) {
        const primitives = addCityGeometry(cesium, viewer, buildings);
        const labels = viewer.scene.primitives.add(new LabelCollection());
        const label = labels.add({ ...labelStyle, position: Cartesian3.ZERO, show: false });
        updateCityLabel.current = (id) => {
          const selected = id ? byId.get(id) : undefined;
          label.show = Boolean(selected);
          if (selected) {
            label.position = roofPosition(selected);
            label.text = demoScore(selected.demoRisk).toFixed(1);
            label.fillColor = Color.fromCssColorString(riskColor(selected.demoRisk));
          }
        };
        updateCityLabel.current(activeIdRef.current);
        removeRenderListener = viewer.scene.postRender.addEventListener(() => {
          if (primitives.every((primitive) => primitive.ready)) {
            removeRenderListener?.();
            setStatus("ready");
          }
        });
      } else {
        for (const building of buildings) {
          const color = Color.fromCssColorString(riskColor(building.demoRisk));
          entities.set(building.id, viewer.entities.add({
            id: building.id,
            name: building.name,
            position: roofPosition(building),
            polygon: {
              hierarchy: new PolygonHierarchy(footprint(cesium, building)),
              height: 0,
              extrudedHeight: building.height_m,
              material: color,
              outline: true,
              outlineColor: color,
            },
            label: { ...labelStyle, text: demoScore(building.demoRisk).toFixed(1), fillColor: color },
          }));
        }
      }

      if (buildings.length) {
        const bounds = BoundingSphere.fromPoints(buildings.map(roofPosition));
        const pitch = batched ? -1.05 : -0.65;
        viewer.camera.viewBoundingSphere(bounds, new HeadingPitchRange(0.3, pitch, Math.max(170, bounds.radius * 3.2)));
        viewer.camera.lookAtTransform(cesium.Matrix4.IDENTITY);
      }

      const currentViewer = viewer;
      handler = new ScreenSpaceEventHandler(currentViewer.scene.canvas);
      handler.setInputAction(({ position }: { position: InstanceType<Cesium["Cartesian2"]> }) => {
        const picked = currentViewer.scene.pick(position);
        const entity = picked?.id;
        const id = entity instanceof cesium.Entity ? entity.id : entity;
        if (typeof id === "string" && byId.has(id)) onSelect(id);
      }, ScreenSpaceEventType.LEFT_CLICK);
      const id = activeIdRef.current;
      currentViewer.selectedEntity = id ? entities.get(id) : undefined;
      if (!batched) setStatus("ready");
    }

    renderBuildings().catch(() => {
      if (!stopped) setStatus("error");
    });

    return () => {
      stopped = true;
      removeRenderListener?.();
      handler?.destroy();
      viewer?.destroy();
      viewerRef.current = null;
      updateCityLabel.current = undefined;
    };
  }, [batched, buildings, onSelect]);

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

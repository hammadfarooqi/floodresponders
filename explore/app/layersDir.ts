import path from "node:path";

// Layers written by data/pipeline/export_layers.py. Override with LAYERS_DIR if needed.
export const LAYERS_DIR = process.env.LAYERS_DIR ?? path.resolve(process.cwd(), "../data/processed/layers");

import 'dart:async';

import 'package:maplibre_gl/maplibre_gl.dart';

class MapUtils {
  static const defaultSourceId = 'asset-map-markers';
  static const defaultHeatMapLayerId = 'asset-heatmap-layer';
  static var completer = Completer()..complete();

  static const defaultHeatMapLayerProperties = HeatmapLayerProperties(
    heatmapColor: [
      Expressions.interpolate,
      ["linear"],
      ["heatmap-density"],
      0.0,
      "rgba(103,58,183,0.0)",
      0.3,
      "rgb(103,58,183)",
      0.5,
      "rgb(33,149,243)",
      0.7,
      "rgb(76,175,79)",
      0.95,
      "rgb(255,235,59)",
      1.0,
      "rgb(255,86,34)",
    ],
    heatmapIntensity: [
      Expressions.interpolate, ["linear"],
      [Expressions.zoom],
      0, 0.5,
      9, 2,
    ],
    heatmapRadius: [
      Expressions.interpolate, ["linear"],
      [Expressions.zoom],
      0, 4,
      4, 8,
      9, 16,
    ],
    heatmapOpacity: 0.7,
  );
}

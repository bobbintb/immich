import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/asyncvalue_extensions.dart';
import 'package:immich_mobile/presentation/widgets/map/utils.dart';
import 'package:immich_mobile/presentation/widgets/map/map.state.dart';
import 'package:immich_mobile/widgets/map/map_theme_override.dart';
import 'package:logging/logging.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

class DriftMapWithMarker extends ConsumerStatefulWidget {
  const DriftMapWithMarker({super.key});

  @override
  ConsumerState<DriftMapWithMarker> createState() => _DriftMapWithMarkerState();
}

class _DriftMapWithMarkerState extends ConsumerState<DriftMapWithMarker> {
  MapLibreMapController? mapController;

  @override
  void initState() {
    super.initState();
  }

  @override
  void dispose() {
    mapController?.dispose();
    super.dispose();
  }

  Future<void> onMapCreated(MapLibreMapController controller) async {
    mapController = controller;
    await setBounds();
  }

  Future<void> onMapMoved() async {
    await setBounds();
  }

  Future<void> setBounds() async {
    if (mapController == null) return;
    final bounds = await mapController!.getVisibleRegion();
    ref.watch(mapStateProvider.notifier).setBounds(bounds);
  }

  Future<void> reloadMarkers(Map<String, dynamic> markers) async {
    if (mapController == null) return;

    // Wait for previous reload to complete
    if (!MapUtils.completer.isCompleted) {
      return MapUtils.completer.future;
    }
    MapUtils.completer = Completer();

    // !! Make sure to remove layers before sources else the native
    // maplibre library would crash when removing the source saying that
    // the source is still in use
    final existingLayers = await mapController!.getLayerIds();
    if (existingLayers.contains(MapUtils.defaultHeatMapLayerId)) {
      await mapController!.removeLayer(MapUtils.defaultHeatMapLayerId);
    }

    final existingSources = await mapController!.getSourceIds();
    if (existingSources.contains(MapUtils.defaultSourceId)) {
      await mapController!.removeSource(MapUtils.defaultSourceId);
    }

    await mapController!.addSource(MapUtils.defaultSourceId, GeojsonSourceProperties(data: markers));

    if (Platform.isAndroid) {
      await mapController!.addCircleLayer(
        MapUtils.defaultSourceId,
        MapUtils.defaultHeatMapLayerId,
        const CircleLayerProperties(
          circleRadius: 10,
          circleColor: "rgba(150,86,34,0.7)",
          circleBlur: 1.0,
          circleOpacity: 0.7,
          circleStrokeWidth: 0.1,
          circleStrokeColor: "rgba(203,46,19,0.5)",
          circleStrokeOpacity: 0.7,
        ),
      );
    } else if (Platform.isIOS) {
      await mapController!.addHeatmapLayer(
        MapUtils.defaultSourceId,
        MapUtils.defaultHeatMapLayerId,
        MapUtils.defaultHeatMapLayerProperties,
      );
    }

    MapUtils.completer.complete();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        _Map(
          onMapCreated: onMapCreated,
          onMapMoved: onMapMoved,
        ),
        _Markers(
          reloadMarkers: reloadMarkers,
        ),
      ],
    );
  }
}

class _Map extends StatelessWidget {
  const _Map({
    required this.onMapCreated,
    required this.onMapMoved,
  });

  final MapCreatedCallback onMapCreated;
  final OnCameraIdleCallback onMapMoved;

  @override
  Widget build(BuildContext context) {
    return MapThemeOverride(
      mapBuilder: (style) =>
        style.widgetWhen(onData: (style) =>
          MapLibreMap(
            initialCameraPosition: const CameraPosition(
              target: LatLng(0, 0),
              zoom: 0,
            ),
            styleString: style,
            onMapCreated: onMapCreated,
            onCameraIdle: onMapMoved,
          ),
        ),
    );
  }
}

class _Markers extends ConsumerWidget {
  const _Markers({required this.reloadMarkers});

  final Function(Map<String, dynamic>) reloadMarkers;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // This logger is only for debug
    final logger = Logger("marker");

    final initBounds = ref.watch(mapStateProvider.select((s) => s.bounds));
    AsyncValue<Map<String, dynamic>> asyncMarkers = ref.watch(mapMarkerProvider(initBounds));

    ref.listen(mapStateProvider, (previous, next) async {
      asyncMarkers = ref.watch(mapMarkerProvider(next.bounds));
    });

    return asyncMarkers.widgetWhen(
      onData: (markers) {
        logger.log(Level.INFO, markers);
        reloadMarkers(markers);
        return const SizedBox.shrink();
      },
    );
  }
}

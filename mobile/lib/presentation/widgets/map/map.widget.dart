import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/asyncvalue_extensions.dart';
import 'package:immich_mobile/presentation/widgets/map/map.state.dart';
import 'package:logging/logging.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

class DriftMapWithMarker extends ConsumerStatefulWidget {
  const DriftMapWithMarker({super.key});

  @override
  ConsumerState<DriftMapWithMarker> createState() => _DriftMapWithMarkerState();
}

class _DriftMapWithMarkerState extends ConsumerState<DriftMapWithMarker> {
  MapLibreMapController? _mapController;

  @override
  void initState() {
    super.initState();
  }

  @override
  void dispose() {
    _mapController?.dispose();
    super.dispose();
  }

  void onMapCreated(MapLibreMapController controller) async {
    _mapController = controller;
    await reloadMarkers();
  }

  void onMapMoved() async {
    await reloadMarkers();
  }

  reloadMarkers() async {
    if (_mapController == null) return;
    final bounds = await _mapController!.getVisibleRegion();
    ref.watch(mapStateProvider.notifier).setBounds(bounds);
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        _Map(
          onMapCreated: onMapCreated,
          onMapMoved: onMapMoved,
        ),
        const _Markers(),
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
    return MapLibreMap(
      initialCameraPosition: const CameraPosition(
        target: LatLng(0, 0),
        zoom: 0,
      ),
      onMapCreated: onMapCreated,
      onCameraIdle: onMapMoved,
    );
  }
}

class _Markers extends ConsumerWidget {
  const _Markers();

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
        return const SizedBox.shrink();
      },
    );
  }
}

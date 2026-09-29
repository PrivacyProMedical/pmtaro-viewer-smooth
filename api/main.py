import sys
import time
import io
import json
from pathlib import Path
import setuptools
import pydicom
import numpy as np
from skimage.filters import gaussian

def smooth(data, sigma=0.3):
    start = time.time()
    print(f"Smooth start with Sigma={sigma}")
    smoothed_data = gaussian(data, sigma, preserve_range=True)
    print(f"It takes {time.time() - start} sec")
    return smoothed_data


# Free-mode reference: keep the original matrix-smoothing helper available so
# standardized public functions can wrap it without losing the old shape.
_legacy_smooth_matrix = smooth

def smooth_2d(dcm_bytes, sigma=0.3):
    ds = pydicom.dcmread(io.BytesIO(dcm_bytes))
    data = ds.pixel_array
    smoothed_data = _legacy_smooth_matrix(data, sigma)

    ds.file_meta.TransferSyntaxUID = pydicom.uid.ExplicitVRLittleEndian
    ds.PixelData = smoothed_data.astype(data.dtype).tobytes()
    buff = io.BytesIO()
    ds.save_as(buff)
    return bytes(buff.getvalue())


def smooth(selection, sigma=0.3, output_dir=''):
    if hasattr(selection, 'to_py'):
        selection = selection.to_py()

    payload = selection or {}
    entry = payload.get('selection') if isinstance(payload, dict) else None
    if not isinstance(entry, dict):
        entry = payload if isinstance(payload, dict) else None
    if not isinstance(entry, dict):
        raise ValueError('selection must be a FILE payload object.')

    file_name = entry.get('fileName') or entry.get('name')
    file_path = entry.get('path') or entry.get('filePath')
    if not file_name or not file_path:
        raise ValueError('selection must provide fileName/name and path/filePath.')

    with open(file_path, 'rb') as fobj:
        dcm_bytes = fobj.read()

    result_bytes = smooth_2d(dcm_bytes, float(sigma))

    output_dir_path = Path(output_dir or '/tmp/smooth_outputs')
    output_dir_path.mkdir(parents=True, exist_ok=True)

    output_name = f'smoothed_{file_name}'
    output_path = output_dir_path / output_name
    output_path.write_bytes(result_bytes)

    return {
        'from': 'module',
        'selection': {
            'name': output_name,
            'path': str(output_path),
            'isFile': True,
        },
    }


# ---------------------------------------------------------------------------
# Series (3D) smoothing
#
# `smooth_series` consumes a parsed-tree SERIES and returns a SERIES whose
# instances are new DICOM files written into `output_dir`. Returning SERIES
# (rather than a single NIfTI file) is what keeps the node wireable into other
# SERIES consumers such as @pmt/series-mip and @pmt/mpfsl.
#
# Smoothing model:
#   sigma_z == 0  -> each slice is smoothed independently with a 2D Gaussian
#                    (layer profile is preserved; the default).
#   sigma_z  > 0  -> one true 3D Gaussian with (sigma_z, sigma, sigma).
#
# Both sigmas are expressed in VOXELS, matching the existing 2D entry point.
# With anisotropic spacing a "spherical" kernel therefore needs sigma_z scaled
# by PixelSpacing / SliceThickness by the caller.
# ---------------------------------------------------------------------------

_IMAGETYPE_SMOOTHED = ['DERIVED', 'SECONDARY', 'SMOOTHED']
_SERIES_NUMBER_OFFSET = 1000
_SERIES_DESCRIPTION_SUFFIX = ' smoothed'


def _as_plain(payload):
    if hasattr(payload, 'to_py'):
        return payload.to_py()
    return payload


def _series_selection(payload):
    payload = _as_plain(payload)
    if not isinstance(payload, dict):
        raise ValueError('data_series must be a SERIES payload object.')
    selection = payload.get('selection')
    if not isinstance(selection, dict):
        raise ValueError('data_series must contain a selection object.')
    if selection.get('slot') != 'series':
        raise ValueError("data_series.selection.slot must be 'series'.")
    return selection


def _ordered_series_nodes(selection):
    """Return [(key, node)] in display order, tolerating a missing in-order list."""
    instances = selection.get('instances')
    if not isinstance(instances, dict):
        instances = {}

    ordered = []
    seen = set()
    in_order = selection.get('instancesInOrder')
    if isinstance(in_order, list):
        for entry in in_order:
            key = entry.get('key') if isinstance(entry, dict) else entry
            if key is None or key in seen:
                continue
            node = instances.get(key)
            if isinstance(node, dict):
                ordered.append((key, node))
                seen.add(key)
    for key, node in instances.items():
        if key not in seen and isinstance(node, dict):
            ordered.append((key, node))
            seen.add(key)
    return ordered


def _instance_sort_key(dataset, fallback_index):
    position = getattr(dataset, 'ImagePositionPatient', None)
    if position is not None and len(position) >= 3:
        try:
            return ('position', float(position[2]), fallback_index)
        except (TypeError, ValueError):
            pass
    number = getattr(dataset, 'InstanceNumber', None)
    if number is not None:
        try:
            return ('instance', float(number), fallback_index)
        except (TypeError, ValueError):
            pass
    return ('payload', float(fallback_index), fallback_index)


def _safe_folder_name(text):
    cleaned = []
    for ch in str(text or ''):
        if ch.isalnum() or ch in ('-', '_'):
            cleaned.append(ch)
        elif ch in (' ', '.', '/'):
            cleaned.append('-')
    name = ''.join(cleaned).strip('-')
    while '--' in name:
        name = name.replace('--', '-')
    return (name[:60] or 'series') + '-smoothed'


def _pixel_bounds(array):
    dtype = array.dtype
    if np.issubdtype(dtype, np.integer):
        info = np.iinfo(dtype)
        return float(info.min), float(info.max), dtype
    return None, None, dtype


def smooth_series(data_series, sigma=0.3, sigma_z=0.0, output_dir=''):
    """Smooth every slice of a DICOM series and return a new SERIES payload.

    Writes one smoothed DICOM file per input instance into
    ``<output_dir>/<series-description>-smoothed/`` and returns a manifest that
    ``main.js`` bridges to the host and turns into a standard SERIES payload.
    """
    selection = _series_selection(data_series)
    nodes = _ordered_series_nodes(selection)
    if not nodes:
        raise ValueError('data_series contains no instances to smooth.')

    datasets = []
    for key, node in nodes:
        file_path = node.get('filePath') or node.get('path')
        if not file_path:
            raise ValueError(f'Series instance {key!r} has no filePath.')
        with open(file_path, 'rb') as handle:
            datasets.append(pydicom.dcmread(io.BytesIO(handle.read())))

    # Order slices consistently: ImagePositionPatient when every slice has it,
    # otherwise InstanceNumber, otherwise the payload's own order.
    have_positions = all(getattr(ds, 'ImagePositionPatient', None) is not None for ds in datasets)
    have_numbers = all(getattr(ds, 'InstanceNumber', None) is not None for ds in datasets)
    if have_positions or have_numbers:
        order = sorted(
            range(len(datasets)),
            key=lambda idx: _instance_sort_key(datasets[idx], idx),
        )
        nodes = [nodes[idx] for idx in order]
        datasets = [datasets[idx] for idx in order]

    slices = []
    for index, (key, node) in enumerate(nodes):
        dataset = datasets[index]
        pixels = np.asarray(dataset.pixel_array)
        if pixels.ndim != 2:
            raise ValueError(
                'smooth_series supports single-frame instances only; '
                f'{node.get("fileName") or key!r} has {pixels.ndim} dimensions.'
            )
        if int(getattr(dataset, 'SamplesPerPixel', 1) or 1) != 1:
            raise ValueError(
                'smooth_series supports monochrome instances only; '
                f'{node.get("fileName") or key!r} has SamplesPerPixel > 1.'
            )
        slices.append((key, node, dataset, pixels))

    shapes = {frame.shape for _, _, _, frame in slices}
    if len(shapes) > 1:
        raise ValueError('All instances in the series must share the same pixel grid.')

    sigma_value = float(sigma)
    sigma_z_value = float(sigma_z)
    if sigma_value < 0 or sigma_z_value < 0:
        raise ValueError('sigma and sigma_z must be >= 0.')

    stack = np.stack([frame.astype(np.float64, copy=False) for _, _, _, frame in slices])
    if sigma_z_value > 0.0:
        smoothed_stack = gaussian(
            stack,
            (sigma_z_value, sigma_value, sigma_value),
            preserve_range=True,
        )
    else:
        # Per-slice 2D. Stacking keeps a single vectorized call; the loop below
        # is over a small constant (4 or 5) inside skimage, never over pixels.
        smoothed_stack = gaussian(stack, (0.0, sigma_value, sigma_value), preserve_range=True)

    series_description = str(getattr(slices[0][2], 'SeriesDescription', '') or '').strip()
    try:
        series_number = int(getattr(slices[0][2], 'SeriesNumber', 0) or 0)
    except (TypeError, ValueError):
        series_number = 0

    output_dir_name = _safe_folder_name(series_description or selection.get('name'))
    output_dir_path = Path(output_dir or '/tmp/smooth_series_outputs') / output_dir_name
    output_dir_path.mkdir(parents=True, exist_ok=True)

    series_instance_uid = pydicom.uid.generate_uid()
    manifest = []
    for index, (key, node, dataset, frame) in enumerate(slices):
        low, high, dtype = _pixel_bounds(frame)
        values = smoothed_stack[index]
        if low is not None:
            values = np.clip(np.rint(values), low, high)
        else:
            values = np.rint(values)

        output_name = node.get('fileName') or node.get('name') or f'slice_{index:04d}.dcm'

        dataset.SOPInstanceUID = pydicom.uid.generate_uid()
        dataset.SeriesInstanceUID = series_instance_uid
        if series_description:
            dataset.SeriesDescription = series_description + _SERIES_DESCRIPTION_SUFFIX
        dataset.SeriesNumber = series_number + _SERIES_NUMBER_OFFSET
        dataset.ImageType = list(_IMAGETYPE_SMOOTHED)
        if 'NumberOfFrames' in dataset:
            del dataset.NumberOfFrames
        dataset.file_meta.TransferSyntaxUID = pydicom.uid.ExplicitVRLittleEndian
        dataset.file_meta.MediaStorageSOPInstanceUID = dataset.SOPInstanceUID
        dataset.PixelData = values.astype(dtype).tobytes()

        buffer = io.BytesIO()
        dataset.save_as(buffer, write_like_original=False)

        # Python cannot reach the host filesystem: write into the Pyodide VFS
        # and let main.js copy each slice back with bridgeFileFromVFS().
        virtual_path = f'/tmp/smooth_series_{index:04d}_{output_name}'
        with open(virtual_path, 'wb') as handle:
            handle.write(buffer.getvalue())

        manifest.append({
            'key': key,
            'name': output_name,
            'virtualPath': virtual_path,
            'instanceNumber': int(getattr(dataset, 'InstanceNumber', index + 1) or (index + 1)),
        })

    return {
        'seriesName': output_dir_name,
        'seriesDescription': (series_description + _SERIES_DESCRIPTION_SUFFIX) if series_description else output_dir_name,
        'instanceCount': len(manifest),
        'sigma': sigma_value,
        'sigma_z': sigma_z_value,
        'slices': manifest,
    }

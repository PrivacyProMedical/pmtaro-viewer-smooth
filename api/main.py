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
        raise ValueError('selection must be an INSTANCE payload object.')

    if entry.get('slot') != 'instance':
        raise ValueError("selection must have selection.slot == 'instance'.")

    file_name = entry.get('fileName') or entry.get('name')
    file_path = entry.get('filePath')
    if not file_name or not file_path:
        raise ValueError('selection must provide fileName/name and filePath.')

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

# def smooth_3d ...

# Standard-mode export declaration.
#
# This optional object is how a Python module explicitly declares which public
# functions are exported to the module frontend, along with their standardized
# argument and return types. Any other `def` in this file remains available as
# free-mode reference code or internal helper logic.
__export_module_api__ = {
    'version': 1,
    'functions': {
        'smooth': {
            'args': [
                {'name': 'selection', 'type': 'INSTANCE'},
                {'name': 'sigma', 'type': 'NUMBER', 'required': False, 'default': 0.3},
                {'name': 'output_dir', 'type': 'STRING'},
            ],
            'returns': {
                'type': 'FILE',
            },
        },
    },
}

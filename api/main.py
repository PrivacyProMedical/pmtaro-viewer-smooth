import sys
import time
import io
import json
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

def smooth_2d(dcm_bytes, sigma=0.3):
    ds = pydicom.dcmread(io.BytesIO(dcm_bytes))
    data = ds.pixel_array
    smoothed_data = smooth(data, sigma)

    ds.file_meta.TransferSyntaxUID = pydicom.uid.ExplicitVRLittleEndian
    ds.PixelData = smoothed_data.astype(data.dtype).tobytes()
    buff = io.BytesIO()
    ds.save_as(buff)
    return bytes(buff.getvalue())

# def smooth_3d ...

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadPyodide } from 'pyodide';
import {
  createPyodideModuleRuntime,
} from '../../../utils/apiLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const runtime = createPyodideModuleRuntime({
  moduleDir: __dirname,
  loadPyodide,
  sourceLabel: '@pmt/smooth api/main.py',
  cExtensionPackages: [
    'setuptools',
    'scikit-image',
    'numpy',
  ],
  wheelPackages: [
    'pydicom',
  ],
});

async function __init__(ctx) {
  return runtime.init(ctx);
}

/*
Free-mode reference: keep the original hand-written JS bridge so the old
module style remains visible even after the standardized path is added.

async function legacySmoothApi(selection, sigma = 1.0, outputDir) {
  const pyodide = await __init__();
  if (!pyodide) return;

  const type = selection?.slot === 'instance' ? '2D' : selection?.slot === 'series' ? '3D' : 'unknown';
  if (type === '2D') {
    const { fileName, filePath } = selection;

    const smooth2D = pyodide.globals.get('smooth_2d');
    const dcmBytesPy = pyodide.toPy(new Uint8Array(fs.readFileSync(filePath)));
    const resPy = smooth2D(dcmBytesPy, parseFloat(sigma));
    const res = resPy.toJs();

    smooth2D.destroy();
    dcmBytesPy.destroy();
    resPy.destroy();

    const outputName = `smoothed_${fileName}`;
    const outputPath = join(outputDir, outputName);
    fs.writeFileSync(outputPath, Buffer.from(res));

    return { name: outputName, path: outputPath };
  } else if (type === '3D') {
    // TODO: smooth 3D series
    // ...
  }
}
*/

async function standardSmoothApi(selectionPayload, sigma = 1.0, outputDir) {
  await __init__();

  const resolvedArgs = runtime.validateCall('smooth', [
    selectionPayload,
    parseFloat(sigma),
    outputDir,
  ]);

  const hostOutputDir = resolvedArgs[2] || join(__dirname, 'api', 'smooth_outputs');

  const result = await runtime.invokePythonFunction('smooth', [
    runtime.stageFilePayload(resolvedArgs[0], 'selection'),
    resolvedArgs[1],
    hostOutputDir,
  ]);

  runtime.validateResult('smooth', result);
  const bridgedPayload = runtime.bridgeOutputFilePayloadToHost(result, hostOutputDir);

  return {
    ...bridgedPayload,
    // Compatibility with the old smooth UI shape.
    name: bridgedPayload?.selection?.name,
    path: bridgedPayload?.selection?.path,
  };
}

// Series (3D) entry point. Python writes one smoothed DICOM per input slice
// into the Pyodide VFS and returns a manifest; this bridge copies each slice to
// the host and assembles a standard SERIES payload, so the node can be wired
// into other SERIES consumers (@pmt/series-mip, @pmt/mpfsl, ...).
async function standardSmoothSeriesApi(dataSeriesPayload, sigma = 0.3, sigmaZ = 0.0, outputDir) {
  await __init__();

  const resolvedArgs = runtime.validateCall('smooth_series', [
    dataSeriesPayload,
    parseFloat(sigma),
    parseFloat(sigmaZ),
    outputDir,
  ]);

  const hostRoot = resolvedArgs[3] || join(__dirname, 'api', 'smooth_series_outputs');

  const result = await runtime.invokePythonFunction('smooth_series', [
    runtime.stageSeriesPayload(resolvedArgs[0], 'data_series'),
    resolvedArgs[1],
    resolvedArgs[2],
    hostRoot,
  ]);

  const seriesDir = join(hostRoot, result.seriesName);
  fs.mkdirSync(seriesDir, { recursive: true });

  const instances = {};
  const instancesInOrder = [];
  for (const slice of result.slices) {
    const hostPath = join(seriesDir, slice.name);
    runtime.bridgeFileFromVFS(slice.virtualPath, hostPath);
    instances[slice.key] = {
      name: slice.name,
      fileName: slice.name,
      filePath: hostPath,
      isFile: true,
      isVolume: false,
      InstanceNumber: slice.instanceNumber,
    };
    instancesInOrder.push({ key: slice.key, InstanceNumber: slice.instanceNumber });
  }

  const seriesPayload = {
    from: 'patient',
    root: hostRoot,
    // Synthesized label path: this series has no parsed-tree ancestry.
    keys: [hostRoot, 'smooth-series', result.seriesName],
    selection: {
      slot: 'series',
      level: 3,
      name: result.seriesName,
      SeriesDescription: result.seriesDescription,
      instances,
      instancesInOrder,
    },
  };

  runtime.validateResult('smooth_series', seriesPayload);

  return {
    ...seriesPayload,
    summary: {
      outputDir: seriesDir,
      instanceCount: result.instanceCount,
      sigma: result.sigma,
      sigma_z: result.sigma_z,
    },
  };
}

export default {
  meta: {
    // ...
  },
  async setup(ctx = {/* __file__, __name__, __author__, __version__ */}, electronApp) {
    return electronApp.whenReady().then(() => {
      return __init__(ctx);
    });
  },
  ui: {
    entry: 'ui/index.html',
    windowOptions: {
      width: 500,
      height: 720,
      minWidth: 500,
      minHeight: 500,
    },
  },
  api: {
    // test: (...args) => ({ args }),

    /*
    Free-mode reference: previous hand-written JS bridge style.

    async smooth(selection, sigma = 1.0, outputDir) {
      pyodide = await __init__();
      if (!pyodide) return;

      const type = selection?.slot === 'instance' ? '2D' : selection?.slot === 'series' ? '3D' : 'unknown';
      if (type === '2D') {
        const { fileName, filePath } = selection;

        const smooth2D = pyodide.globals.get('smooth_2d');
        const dcmBytesPy = pyodide.toPy(new Uint8Array(fs.readFileSync(filePath)));
        const resPy = smooth2D(dcmBytesPy, parseFloat(sigma));
        const res = resPy.toJs();

        smooth2D.destroy();
        dcmBytesPy.destroy();
        resPy.destroy();

        const outputName = `smoothed_${fileName}`;
        const outputPath = join(outputDir, outputName);
        fs.writeFileSync(outputPath, Buffer.from(res));

        return { name: outputName, path: outputPath };
      } else if (type === '3D') {
        // TODO: smooth 3D series
        // ...
      }
    },
    */

    async smooth(selectionPayload, sigma = 1.0, outputDir) {
      return standardSmoothApi(selectionPayload, sigma, outputDir);
    },

    async smooth_series(dataSeriesPayload, sigma = 0.3, sigmaZ = 0.0, outputDir) {
      return standardSmoothSeriesApi(dataSeriesPayload, sigma, sigmaZ, outputDir);
    },
  },
  // contextMenus: [],
};

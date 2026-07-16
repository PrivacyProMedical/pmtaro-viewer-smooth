import { fileURLToPath } from 'node:url';
import { dirname, basename, join } from 'node:path';

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

  const normalizedSelectionPayload = runtime.cloneJson(resolvedArgs[0]);
  const selectionEntry = normalizedSelectionPayload?.selection ?? normalizedSelectionPayload;
  const hostInputPath = selectionEntry?.filePath;
  const inputFileName = selectionEntry?.fileName || selectionEntry?.name || basename(hostInputPath || 'input.dcm');
  const virtualInputPath = `/tmp/${Date.now()}_${basename(hostInputPath || inputFileName)}`;
  const virtualOutputDir = '/tmp/smooth_outputs';

  if (!hostInputPath) {
    throw new Error('smooth requires selection.selection.filePath for standard mode.');
  }

  runtime.bridgeHostFileToVFS(hostInputPath, virtualInputPath);
  selectionEntry.filePath = virtualInputPath;
  const pyodide = runtime.getPyodide();
  try {
    pyodide.FS.mkdir(virtualOutputDir);
  } catch {}

  const result = await runtime.invokePythonFunction('smooth', [
    normalizedSelectionPayload,
    resolvedArgs[1],
    virtualOutputDir,
  ]);

  runtime.validateResult('smooth', result);

  const outputName = result?.selection?.name || `smoothed_${inputFileName}`;
  const virtualOutputPath = result?.selection?.path;
  const hostOutputPath = join(resolvedArgs[2], outputName);
  runtime.bridgeFileFromVFS(virtualOutputPath, hostOutputPath);

  return {
    ...result,
    selection: {
      ...result.selection,
      path: hostOutputPath,
    },
    // Compatibility with the old smooth UI shape.
    name: outputName,
    path: hostOutputPath,
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

    __debug_export_module_api__: runtime.createDebugHandler(),
  },
  // contextMenus: [],
};

import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { loadPyodide } from 'pyodide';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const platform = process.platform || os.platform();
const isMac = platform === 'darwin';
// const isWin = platform === 'win32';

var main_py = '';
var py = '';
var pyodide = null;

async function __init__(ctx) {
  if (pyodide || py || main_py) {
    return pyodide;
  }
  if (ctx?.__file__) {
    main_py = join(dirname(ctx.__file__), 'api', 'main.py');
  }
  if (main_py && fs.existsSync(main_py)) {
    py = fs.readFileSync(main_py, 'utf-8');
  }
  if (py) {
    const packageCacheDir = join(dirname(main_py), 'requirements');
    if (!fs.existsSync(packageCacheDir)) {
      fs.mkdirSync(packageCacheDir);
    }
    pyodide = await loadPyodide({ packageCacheDir });
    await pyodide.loadPackage('micropip');
    const micropip = pyodide.pyimport('micropip');
    // install packages built in pyodide
    await micropip.install('setuptools');    
    await micropip.install('scikit-image');
    await micropip.install('numpy');
    // install standard PyPI wheels
    const pydicom = fs.readdirSync(packageCacheDir).find(f => f.startsWith('pydicom-') && f.endsWith('.whl'));
    await micropip.install(fs.existsSync(join(packageCacheDir, pydicom)) ? pathToFileURL(join(packageCacheDir, pydicom)).href : 'pydicom');
    // ...
    await pyodide.runPythonAsync(py);
    micropip.destroy();
  }
  return pyodide;
}

export default {
  meta: {
    name: 'Smooth 2D3D',
    version: '1.0.0',
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

    async smooth(selection, sigma = 1.0, outputDir) {
      pyodide = await __init__();
      if (!pyodide) return;

      // const res = await pyodide.runPythonAsync(`sys.version`);
      // console.log(res);

      const type = selection?.slot === 'instance' ? '2D' : selection?.slot === 'series' ? '3D' : 'unknown';
      if (type === '2D') {
        const { fileName, filePath } = selection;
        // console.log({ name: fileName, path: filePath });

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
  },
  // contextMenus: [],
};

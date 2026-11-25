const path = require('path');

const root = path.join(__dirname, '..');

/** Keep this list in sync with PARTS in tools/build.mjs. */
const sources = [
  'Index.html',
  'Icons.html',
  'Part1_Data.html',
  'Part2_App.html',
  'Part3_ViewsA.html',
  'Part4_ViewsB.html',
  'Part5_Modules.html',
];

module.exports = {
  darkMode: 'class',
  content: sources.map(function (file) {
    return path.join(root, file);
  }),
  theme: { extend: {} },
  plugins: []
};

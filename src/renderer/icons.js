'use strict';
const ICONS = {
 "file": "<path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z\"/><path d=\"M14 2v6h6\"/><path d=\"M16 13H8\"/><path d=\"M16 17H8\"/>",
 "spell": "<path d=\"M18 6 7 17l-5-5\"/><path d=\"m22 10-7.5 7.5L13 16\"/>",
 "compare": "<circle cx=\"18\" cy=\"18\" r=\"3\"/><circle cx=\"6\" cy=\"6\" r=\"3\"/><path d=\"M13 6h3a2 2 0 0 1 2 2v7\"/><path d=\"M11 18H8a2 2 0 0 1-2-2V9\"/>",
 "feather": "<path d=\"M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z\"/><path d=\"M16 8 2 22\"/><path d=\"M17.5 15H9\"/>",
 "book": "<path d=\"M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z\"/><path d=\"M20 17v5H6.5A2.5 2.5 0 0 1 4 19.5\"/>",
 "sliders": "<path d=\"M4 21v-7\"/><path d=\"M4 10V3\"/><path d=\"M12 21v-9\"/><path d=\"M12 8V3\"/><path d=\"M20 21v-5\"/><path d=\"M20 12V3\"/><path d=\"M1 14h6\"/><path d=\"M9 8h6\"/><path d=\"M17 16h6\"/>",
 "upload": "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><path d=\"m17 8-5-5-5 5\"/><path d=\"M12 3v12\"/>",
 "clip": "<rect x=\"8\" y=\"2\" width=\"8\" height=\"4\" rx=\"1\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"/>",
 "x": "<path d=\"M18 6 6 18\"/><path d=\"m6 6 12 12\"/>",
 "check": "<path d=\"M20 6 9 17l-5-5\"/>",
 "search": "<circle cx=\"11\" cy=\"11\" r=\"8\"/><path d=\"m21 21-4.3-4.3\"/>",
 "download": "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><path d=\"m7 10 5 5 5-5\"/><path d=\"M12 15V3\"/>",
 "lock": "<rect x=\"3\" y=\"11\" width=\"18\" height=\"11\" rx=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/>",
 "down": "<path d=\"m6 9 6 6 6-6\"/>",
 "plus": "<path d=\"M12 5v14M5 12h14\"/>",
 "refresh": "<path d=\"M3 12a9 9 0 0 1 15-6.7L21 8\"/><path d=\"M21 3v5h-5\"/><path d=\"M21 12a9 9 0 0 1-15 6.7L3 16\"/><path d=\"M8 16H3v5\"/>",
 "info": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 16v-4M12 8h.01\"/>",
 "undo": "<path d=\"M3 7v6h6\"/><path d=\"M21 17a9 9 0 0 0-15-6.7L3 13\"/>",
 "arrow": "<path d=\"M5 12h14\"/><path d=\"m12 5 7 7-7 7\"/>",
 "ext": "<path d=\"M15 3h6v6\"/><path d=\"M10 14 21 3\"/><path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\"/>",
 "eye": "<path d=\"M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
 "pencil": "<path d=\"M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z\"/><path d=\"m15 5 4 4\"/>",
 "spinner": "<path d=\"M21 12a9 9 0 1 1-6.22-8.56\"/>",
 "trash": "<path d=\"M3 6h18\"/><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"/><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/>",
 "sparkle": "<path d=\"M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1\"/>"
};
function ic(name, size = 16, color = 'currentColor', sw = 2) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}
